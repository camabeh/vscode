/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import nls = require('vs/nls');
import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import paths = require('vs/base/common/paths');
import encoding = require('vs/base/node/encoding');
import errors = require('vs/base/common/errors');
import strings = require('vs/base/common/strings');
import uri from 'vs/base/common/uri';
import timer = require('vs/base/common/timer');
import { asFileEditorInput } from 'vs/workbench/common/editor';
import { IFileService, IFilesConfiguration, IResolveFileOptions, IFileStat, IContent, IStreamContent, IImportResult, IResolveContentOptions, IUpdateContentOptions } from 'vs/platform/files/common/files';
import { FileService as NodeFileService, IFileServiceOptions, IEncodingOverride } from 'vs/workbench/services/files/node/fileService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEventService } from 'vs/platform/event/common/event';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { Action } from 'vs/base/common/actions';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IMessageService, IMessageWithAction, Severity, CloseAction } from 'vs/platform/message/common/message';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';

import { shell } from 'electron';

export class FileService implements IFileService {

	public _serviceBrand: any;

	// If we run with .NET framework < 4.5, we need to detect this error to inform the user
	private static NET_VERSION_ERROR = 'System.MissingMethodException';
	private static NET_VERSION_ERROR_IGNORE_KEY = 'ignoreNetVersionError';

	private raw: IFileService;

	private toUnbind: IDisposable[];
	private activeOutOfWorkspaceWatchers: { [resource: string]: boolean; };

	constructor(
		@IConfigurationService private configurationService: IConfigurationService,
		@IEventService private eventService: IEventService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IMessageService private messageService: IMessageService,
		@IStorageService private storageService: IStorageService
	) {
		this.toUnbind = [];
		this.activeOutOfWorkspaceWatchers = Object.create(null);

		const configuration = this.configurationService.getConfiguration<IFilesConfiguration>();

		// adjust encodings
		const encodingOverride: IEncodingOverride[] = [];
		encodingOverride.push({ resource: uri.file(environmentService.appSettingsHome), encoding: encoding.UTF8 });
		if (this.contextService.getWorkspace()) {
			encodingOverride.push({ resource: uri.file(paths.join(this.contextService.getWorkspace().resource.fsPath, '.vscode')), encoding: encoding.UTF8 });
		}

		let watcherIgnoredPatterns: string[] = [];
		if (configuration.files && configuration.files.watcherExclude) {
			watcherIgnoredPatterns = Object.keys(configuration.files.watcherExclude).filter(k => !!configuration.files.watcherExclude[k]);
		}

		// build config
		const fileServiceConfig: IFileServiceOptions = {
			errorLogger: (msg: string) => this.onFileServiceError(msg),
			encoding: configuration.files && configuration.files.encoding,
			encodingOverride: encodingOverride,
			watcherIgnoredPatterns: watcherIgnoredPatterns,
			verboseLogging: environmentService.verbose,
		};

		// create service
		const workspace = this.contextService.getWorkspace();
		this.raw = new NodeFileService(workspace ? workspace.resource.fsPath : void 0, fileServiceConfig, this.eventService);

		// Listeners
		this.registerListeners();
	}

	private onFileServiceError(msg: any): void {
		errors.onUnexpectedError(msg);

		// Detect if we run < .NET Framework 4.5
		if (typeof msg === 'string' && msg.indexOf(FileService.NET_VERSION_ERROR) >= 0 && !this.storageService.getBoolean(FileService.NET_VERSION_ERROR_IGNORE_KEY, StorageScope.WORKSPACE)) {
			this.messageService.show(Severity.Warning, <IMessageWithAction>{
				message: nls.localize('netVersionError', "The Microsoft .NET Framework 4.5 is required. Please follow the link to install it."),
				actions: [
					new Action('install.net', nls.localize('installNet', "Download .NET Framework 4.5"), null, true, () => {
						window.open('https://go.microsoft.com/fwlink/?LinkId=786533');

						return TPromise.as(true);
					}),
					new Action('net.error.ignore', nls.localize('neverShowAgain', "Don't Show Again"), '', true, () => {
						this.storageService.store(FileService.NET_VERSION_ERROR_IGNORE_KEY, true, StorageScope.WORKSPACE);

						return TPromise.as(null);
					}),
					CloseAction
				]
			});
		}
	}

	private registerListeners(): void {

		// Config changes
		this.toUnbind.push(this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationChange(e.config)));

		// Editor changing
		this.toUnbind.push(this.editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));

		// Lifecycle
		this.lifecycleService.onShutdown(this.dispose, this);
	}

	private onEditorsChanged(): void {
		this.handleOutOfWorkspaceWatchers();
	}

	private handleOutOfWorkspaceWatchers(): void {
		const visibleOutOfWorkspaceResources = this.editorService.getVisibleEditors().map(editor => {
			return asFileEditorInput(editor.input, true);
		}).filter(input => {
			return !!input && !this.contextService.isInsideWorkspace(input.getResource());
		}).map(input => {
			return input.getResource().toString();
		});

		// Handle no longer visible out of workspace resources
		Object.keys(this.activeOutOfWorkspaceWatchers).forEach(watchedResource => {
			if (visibleOutOfWorkspaceResources.indexOf(watchedResource) < 0) {
				this.unwatchFileChanges(watchedResource);
				delete this.activeOutOfWorkspaceWatchers[watchedResource];
			}
		});

		// Handle newly visible out of workspace resources
		visibleOutOfWorkspaceResources.forEach(resourceToWatch => {
			if (!this.activeOutOfWorkspaceWatchers[resourceToWatch]) {
				this.watchFileChanges(uri.parse(resourceToWatch));
				this.activeOutOfWorkspaceWatchers[resourceToWatch] = true;
			}
		});
	}

	private onConfigurationChange(configuration: IFilesConfiguration): void {
		this.updateOptions(configuration.files);
	}

	public updateOptions(options: any): void {
		this.raw.updateOptions(options);
	}

	public resolveFile(resource: uri, options?: IResolveFileOptions): TPromise<IFileStat> {
		return this.raw.resolveFile(resource, options);
	}

	public existsFile(resource: uri): TPromise<boolean> {
		return this.raw.existsFile(resource);
	}

	public resolveContent(resource: uri, options?: IResolveContentOptions): TPromise<IContent> {
		const contentId = resource.toString();
		const timerEvent = timer.start(timer.Topic.WORKBENCH, strings.format('Load {0}', contentId));

		return this.raw.resolveContent(resource, options).then((result) => {
			timerEvent.stop();

			return result;
		});
	}

	public resolveStreamContent(resource: uri, options?: IResolveContentOptions): TPromise<IStreamContent> {
		const contentId = resource.toString();
		const timerEvent = timer.start(timer.Topic.WORKBENCH, strings.format('Load {0}', contentId));

		return this.raw.resolveStreamContent(resource, options).then((result) => {
			timerEvent.stop();

			return result;
		});
	}

	public resolveContents(resources: uri[]): TPromise<IContent[]> {
		return this.raw.resolveContents(resources);
	}

	public updateContent(resource: uri, value: string, options?: IUpdateContentOptions): TPromise<IFileStat> {
		const timerEvent = timer.start(timer.Topic.WORKBENCH, strings.format('Save {0}', resource.toString()));

		return this.raw.updateContent(resource, value, options).then((result) => {
			timerEvent.stop();

			return result;
		}, (error) => {
			timerEvent.stop();

			return TPromise.wrapError(error);
		});
	}

	public moveFile(source: uri, target: uri, overwrite?: boolean): TPromise<IFileStat> {
		return this.raw.moveFile(source, target, overwrite);
	}

	public copyFile(source: uri, target: uri, overwrite?: boolean): TPromise<IFileStat> {
		return this.raw.copyFile(source, target, overwrite);
	}

	public createFile(resource: uri, content?: string): TPromise<IFileStat> {
		return this.raw.createFile(resource, content);
	}

	public createFolder(resource: uri): TPromise<IFileStat> {
		return this.raw.createFolder(resource);
	}

	public touchFile(resource: uri): TPromise<IFileStat> {
		return this.raw.touchFile(resource);
	}

	public rename(resource: uri, newName: string): TPromise<IFileStat> {
		return this.raw.rename(resource, newName);
	}

	public del(resource: uri, useTrash?: boolean): TPromise<void> {
		if (useTrash) {
			return this.doMoveItemToTrash(resource);
		}

		return this.raw.del(resource);
	}

	private doMoveItemToTrash(resource: uri): TPromise<void> {
		const workspace = this.contextService.getWorkspace();
		if (!workspace) {
			return TPromise.wrapError<void>('Need a workspace to use this');
		}

		const absolutePath = resource.fsPath;

		const result = shell.moveItemToTrash(absolutePath);
		if (!result) {
			return TPromise.wrapError<void>(new Error(nls.localize('trashFailed', "Failed to move '{0}' to the trash", paths.basename(absolutePath))));
		}

		return TPromise.as(null);
	}

	public importFile(source: uri, targetFolder: uri): TPromise<IImportResult> {
		return this.raw.importFile(source, targetFolder).then((result) => {
			return <IImportResult>{
				isNew: result && result.isNew,
				stat: result && result.stat
			};
		});
	}

	public watchFileChanges(resource: uri): void {
		if (!resource) {
			return;
		}

		if (resource.scheme !== 'file') {
			return; // only support files
		}

		// return early if the resource is inside the workspace for which we have another watcher in place
		if (this.contextService.isInsideWorkspace(resource)) {
			return;
		}

		this.raw.watchFileChanges(resource);
	}

	public unwatchFileChanges(resource: uri): void;
	public unwatchFileChanges(path: string): void;
	public unwatchFileChanges(arg1: any): void {
		this.raw.unwatchFileChanges(arg1);
	}

	public getEncoding(resource: uri): string {
		return this.raw.getEncoding(resource);
	}

	public dispose(): void {
		this.toUnbind = dispose(this.toUnbind);

		// Dispose watchers if any
		for (const key in this.activeOutOfWorkspaceWatchers) {
			this.unwatchFileChanges(key);
		}
		this.activeOutOfWorkspaceWatchers = Object.create(null);

		// Dispose service
		this.raw.dispose();
	}
}