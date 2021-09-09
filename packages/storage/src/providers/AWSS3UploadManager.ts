import { AWSS3UploadTask } from './AWSS3UploadTask';
import * as events from 'events';
import {
	S3Client,
	ListPartsCommand,
	ListPartsCommandOutput,
	CreateMultipartUploadCommand,
	AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { StorageHelper, Logger } from '@aws-amplify/core';
import { StorageLevel } from '../types/Storage';

const logger = new Logger('Storage');
const oneHourInMs = 1000 * 60 * 60;

type UploadId = string;

interface AddTaskInput {
	accessLevel: StorageLevel;
	file: Blob;
	bucket: string;
	emitter?: events.EventEmitter;
	key: string;
	s3Client: S3Client;
}

interface FileMetadata {
	accessLevel: StorageLevel;
	bucket: string;
	fileName: string;
	key: string;
	// Unix timestamp in ms
	lastTouched: number;
	timeStarted: number;
	uploadId: UploadId;
}

export enum TaskEvents {
	ABORT = 'abort',
	UPLOAD_COMPLETE = 'uploadComplete',
	UPLOAD_PROGRESS = 'uploadPartProgress',
}

export const UPLOADS_STORAGE_KEY = '__uploadInProgress';

export class AWSS3UploadManager {
	private readonly _storage: Storage;
	private readonly _uploadTasks: Record<UploadId, AWSS3UploadTask> = {};

	constructor() {
		this._storage = new StorageHelper().getStorage();
	}

	private _listUploadTasks() {
		const tasks = this._storage.getItem(UPLOADS_STORAGE_KEY);
		return JSON.parse(tasks);
	}

	private async _getCachedUploadParts({
		s3client,
		bucket,
		key,
		file,
	}: {
		s3client: S3Client;
		bucket: string;
		key: string;
		file: Blob;
	}): Promise<ListPartsCommandOutput> {
		const uploadsFromStorage = this._storage.getItem(UPLOADS_STORAGE_KEY);
		if (!uploadsFromStorage) {
			return null;
		}
		const uploads = JSON.parse(uploadsFromStorage) || {};
		const fileKey = this._getFileKey(file, bucket, key);
		if (!uploads.hasOwnProperty(fileKey)) {
			return null;
		}
		const cachedUploadFileData: FileMetadata =
			uploads[this._getFileKey(file, bucket, key)] || {};
		const hasExpired =
			cachedUploadFileData.hasOwnProperty('lastTouched') &&
			Date.now() - cachedUploadFileData.lastTouched > oneHourInMs;
		if (cachedUploadFileData && !hasExpired) {
			cachedUploadFileData.lastTouched = Date.now();
			this._storage.setItem(UPLOADS_STORAGE_KEY, JSON.stringify(uploads));
			const listPartsOutput = await s3client.send(
				new ListPartsCommand({
					Bucket: bucket,
					Key: key,
					UploadId: cachedUploadFileData.uploadId,
				})
			);
			return listPartsOutput;
		}
	}

	/**
	 * Generate a unique key for the file.
	 *
	 * @param blob - Blob that should be uploaded.
	 * @return unique key of the file.
	 */
	private _getFileKey(blob: Blob, bucket: string, key: string): string {
		// We should check if it's a File first because File is also instance of a Blob
		if (this._isFile(blob)) {
			return [
				blob.name,
				blob.lastModified,
				blob.size,
				blob.type,
				bucket,
				key,
			].join('-');
		} else if (this._isBlob(blob)) {
			return [blob.size, blob.type, bucket, key].join('-');
		} else return '';
	}

	/**
	 * Purge all keys from storage that were expired.
	 *
	 * @param [ttl] - [Specify how long since the task has started should it be considered expired]
	 */
	private _purgeExpiredKeys(input: {
		s3Client: S3Client;
		ttl?: number;
		emitter?: events.EventEmitter;
	}) {
		const { s3Client, ttl = oneHourInMs } = input;
		const uploads: Record<string, FileMetadata> =
			JSON.parse(this._storage.getItem(UPLOADS_STORAGE_KEY)) || {};
		for (const [k, upload] of Object.entries(uploads)) {
			const hasExpired =
				Object.prototype.hasOwnProperty.call(upload, 'timeStarted') &&
				Date.now() - (upload as any).timeStarted > ttl;
			if (hasExpired) {
				s3Client
					.send(
						new AbortMultipartUploadCommand({
							Bucket: upload.bucket,
							Key: upload.key,
							UploadId: upload.uploadId,
						})
					)
					.then(res => {
						delete uploads[k];
					});
			}
		}
		this._storage.setItem(UPLOADS_STORAGE_KEY, JSON.stringify(uploads));
	}

	private _removeKey(key: string) {
		const uploads =
			JSON.parse(this._storage.getItem(UPLOADS_STORAGE_KEY)) || {};
		delete uploads[key];
		this._storage.setItem(UPLOADS_STORAGE_KEY, JSON.stringify(uploads));
	}

	private _isListPartsOutput(x: unknown): x is ListPartsCommandOutput {
		return (
			x &&
			typeof x === 'object' &&
			Object.prototype.hasOwnProperty.call(x, 'UploadId') &&
			Object.prototype.hasOwnProperty.call(x, 'Parts')
		);
	}

	public async addTask(input: AddTaskInput) {
		const { s3Client, bucket, key, file, emitter } = input;
		let cachedUpload = {};
		this._purgeExpiredKeys({
			s3Client,
		});
		try {
			cachedUpload =
				(await this._getCachedUploadParts({
					s3client: s3Client,
					bucket,
					key,
					file,
				})) || {};
		} catch (err) {
			logger.error(
				'Error finding cached upload parts, will re-initialize the multipart upload',
				err
			);
		}
		const fileKey = this._getFileKey(file, bucket, key);
		emitter.on(TaskEvents.UPLOAD_COMPLETE, () => {
			this._removeKey(fileKey);
		});
		emitter.on(TaskEvents.ABORT, () => {
			this._removeKey(fileKey);
		});
		if (this._isListPartsOutput(cachedUpload)) {
			const cachedUploadId = cachedUpload.UploadId;
			const uploadedPartsOnS3 = cachedUpload.Parts;
			this._uploadTasks[cachedUploadId] = new AWSS3UploadTask({
				s3Client,
				uploadId: cachedUpload.UploadId,
				bucket,
				key,
				file,
				completedParts: cachedUpload.Parts,
				emitter,
			});
			return this._uploadTasks[cachedUploadId];
		}
		return this._initMultiupload(input);
	}

	private async _initMultiupload(input: AddTaskInput) {
		const { s3Client, bucket, key, file, emitter, accessLevel } = input;
		const fileKey = this._getFileKey(file as File, bucket, key);
		const createMultipartUpload = await s3Client.send(
			new CreateMultipartUploadCommand({
				Bucket: bucket,
				Key: key,
			})
		);
		const newTask = new AWSS3UploadTask({
			s3Client,
			uploadId: createMultipartUpload.UploadId,
			bucket,
			key,
			file,
			emitter,
		});
		this._uploadTasks[createMultipartUpload.UploadId] = newTask;
		const fileMetadata: FileMetadata = {
			uploadId: createMultipartUpload.UploadId,
			timeStarted: Date.now(),
			lastTouched: Date.now(),
			bucket,
			key,
			accessLevel,
			...(this._isFile(file) && { fileName: file.name }),
		};
		this._addKey(fileKey, fileMetadata);
		return newTask;
	}

	private _addKey(key: string, fileMetadata: FileMetadata) {
		const uploads =
			JSON.parse(this._storage.getItem(UPLOADS_STORAGE_KEY)) || {};
		uploads[key] = fileMetadata;
		this._storage.setItem(UPLOADS_STORAGE_KEY, JSON.stringify(uploads));
	}

	public getTask(uploadId: UploadId) {
		return this._uploadTasks[uploadId];
	}

	private _isBlob(x: unknown): x is Blob {
		return x instanceof Blob;
	}

	private _isFile(x: unknown): x is File {
		return x instanceof File;
	}
}