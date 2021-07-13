// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';
import { Params } from '@angular/router';
import moment from 'moment';

import { CoreSites } from '@services/sites';
import {
    CoreCourse,
    CoreCourseCompletionActivityStatus,
    CoreCourseModuleWSCompletionData,
    CoreCourseModuleContentFile,
    CoreCourseWSModule,
    CoreCourseProvider,
    CoreCourseWSSection,
} from './course';
import { CoreConstants } from '@/core/constants';
import { CoreLogger } from '@singletons/logger';
import { makeSingleton, Translate } from '@singletons';
import { CoreFilepool } from '@services/filepool';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreUtils, CoreUtilsOpenFileOptions } from '@services/utils/utils';
import {
    CoreCourseAnyCourseData,
    CoreCourseBasicData,
    CoreCourses,
} from '@features/courses/services/courses';
import { CoreEnrolledCourseDataWithExtraInfoAndOptions } from '@features/courses/services/courses-helper';
import { CoreArray } from '@singletons/array';
import { CoreIonLoadingElement } from '@classes/ion-loading';
import { CoreCourseOffline } from './course-offline';
import {
    CoreCourseOptionsDelegate,
    CoreCourseOptionsHandlerToDisplay,
    CoreCourseOptionsMenuHandlerToDisplay,
} from './course-options-delegate';
import { CoreCourseModuleDelegate, CoreCourseModuleHandlerData } from './module-delegate';
import { CoreError } from '@classes/errors/error';
import {
    CoreCourseModulePrefetchDelegate,
    CoreCourseModulePrefetchHandler,
    CoreCourseModulesStatus,
} from './module-prefetch-delegate';
import { CoreFileSizeSum } from '@services/plugin-file-delegate';
import { CoreFileHelper } from '@services/file-helper';
import { CoreApp } from '@services/app';
import { CoreSite } from '@classes/site';
import { CoreFile } from '@services/file';
import { CoreUrlUtils } from '@services/utils/url';
import { CoreTextUtils } from '@services/utils/text';
import { CoreTimeUtils } from '@services/utils/time';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreFilterHelper } from '@features/filter/services/filter-helper';
import { CoreNetworkError } from '@classes/errors/network-error';
import { CoreSiteHome } from '@features/sitehome/services/sitehome';
import { CoreNavigator } from '@services/navigator';
import { CoreSiteHomeHomeHandlerService } from '@features/sitehome/services/handlers/sitehome-home';
import { CoreStatusWithWarningsWSResponse } from '@services/ws';

/**
 * Prefetch info of a module.
 */
export type CoreCourseModulePrefetchInfo = {
    /**
     * Downloaded size.
     */
    size?: number;

    /**
     * Downloadable size in a readable format.
     */
    sizeReadable?: string;

    /**
     * Module status.
     */
    status?: string;

    /**
     * Icon's name of the module status.
     */
    statusIcon?: string;

    /**
     * Time when the module was last downloaded.
     */
    downloadTime?: number;

    /**
     * Download time in a readable format.
     */
    downloadTimeReadable?: string;
};

/**
 * Progress of downloading a list of courses.
 */
export type CoreCourseCoursesProgress = {
    /**
     * Number of courses downloaded so far.
     */
    count: number;

    /**
     * Toal of courses to download.
     */
    total: number;

    /**
     * Whether the download has been successful so far.
     */
    success: boolean;

    /**
     * Last downloaded course.
     */
    courseId?: number;
};

export type CorePrefetchStatusInfo = {
    status: string; // Status of the prefetch.
    statusTranslatable: string; // Status translatable string.
    icon: string; // Icon based on the status.
    loading: boolean; // If it's a loading status.
    badge?: string; // Progress badge string if any.
    badgeA11yText?: string; // Description of the badge if any.
    count?: number; // Amount of already downloaded courses.
    total?: number; // Total of courses.
    downloadSucceeded?: boolean; // Whether download has succeeded (in case it's downloaded).
};

/**
 * Helper to gather some common course functions.
 */
@Injectable({ providedIn: 'root' })
export class CoreCourseHelperProvider {

    protected courseDwnPromises: { [s: string]: { [id: number]: Promise<void> } } = {};
    protected logger: CoreLogger;

    constructor() {
        this.logger = CoreLogger.getInstance('CoreCourseHelperProvider');
    }

    /**
     * This function treats every module on the sections provided to load the handler data, treat completion
     * and navigate to a module page if required. It also returns if sections has content.
     *
     * @param sections List of sections to treat modules.
     * @param courseId Course ID of the modules.
     * @param completionStatus List of completion status.
     * @param courseName Course name. Recommended if completionStatus is supplied.
     * @param forCoursePage Whether the data will be used to render the course page.
     * @return Whether the sections have content.
     */
    addHandlerDataForModules(
        sections: CoreCourseWSSection[],
        courseId: number,
        completionStatus?: Record<string, CoreCourseCompletionActivityStatus>,
        courseName?: string,
        forCoursePage = false,
    ): { hasContent: boolean; sections: CoreCourseSection[] } {

        const formattedSections: CoreCourseSection[] = sections;
        let hasContent = false;

        formattedSections.forEach((section) => {
            if (!section || !section.modules) {
                return;
            }

            section.hasContent = this.sectionHasContent(section);

            if (!section.hasContent) {
                return;
            }

            hasContent = true;

            section.modules.forEach((module) => {
                module.handlerData = CoreCourseModuleDelegate.getModuleDataFor(
                    module.modname,
                    module,
                    courseId,
                    section.id,
                    forCoursePage,
                );

                if (module.completiondata) {
                    this.calculateModuleCompletionData(module, courseId, courseName);
                } else if (completionStatus && typeof completionStatus[module.id] != 'undefined') {
                    // Should not happen on > 3.6. Check if activity has completions and if it's marked.
                    const activityStatus = completionStatus[module.id];

                    module.completiondata = {
                        state: activityStatus.state,
                        timecompleted: activityStatus.timecompleted,
                        overrideby: activityStatus.overrideby || 0,
                        valueused: activityStatus.valueused,
                        tracking: activityStatus.tracking,
                        courseId,
                        courseName,
                        cmid: module.id,
                    };
                }

                // Check if the module is stealth.
                module.isStealth = module.visibleoncoursepage === 0 || (!!module.visible && !section.visible);
            });
        });

        return { hasContent, sections: formattedSections };
    }

    /**
     * Calculate completion data of a module.
     *
     * @param module Module.
     * @param courseId Course ID of the module.
     * @param courseName Course name.
     */
    calculateModuleCompletionData(module: CoreCourseModule, courseId: number, courseName?: string): void {
        if (!module.completiondata || !module.completion) {
            return;
        }

        module.completiondata.courseId = courseId;
        module.completiondata.courseName = courseName;
        module.completiondata.tracking = module.completion;
        module.completiondata.cmid = module.id;
    }

    /**
     * Calculate the status of a section.
     *
     * @param section Section to calculate its status. It can't be "All sections".
     * @param courseId Course ID the section belongs to.
     * @param refresh True if it shouldn't use module status cache (slower).
     * @param checkUpdates Whether to use the WS to check updates. Defaults to true.
     * @return Promise resolved when the status is calculated.
     */
    async calculateSectionStatus(
        section: CoreCourseSection,
        courseId: number,
        refresh?: boolean,
        checkUpdates: boolean = true,
    ): Promise<{statusData: CoreCourseModulesStatus; section: CoreCourseSectionWithStatus}> {
        if (section.id == CoreCourseProvider.ALL_SECTIONS_ID) {
            throw new CoreError('Invalid section');
        }

        const sectionWithStatus = <CoreCourseSectionWithStatus> section;

        // Get the status of this section.
        const result = await CoreCourseModulePrefetchDelegate.getModulesStatus(
            section.modules,
            courseId,
            section.id,
            refresh,
            true,
            checkUpdates,
        );

        // Check if it's being downloaded.
        const downloadId = this.getSectionDownloadId(section);
        if (CoreCourseModulePrefetchDelegate.isBeingDownloaded(downloadId)) {
            result.status = CoreConstants.DOWNLOADING;
        }

        sectionWithStatus.downloadStatus = result.status;
        sectionWithStatus.canCheckUpdates = CoreCourseModulePrefetchDelegate.canCheckUpdates();

        // Set this section data.
        if (result.status !== CoreConstants.DOWNLOADING) {
            sectionWithStatus.isDownloading = false;
            sectionWithStatus.total = 0;
        } else {
            // Section is being downloaded.
            sectionWithStatus.isDownloading = true;
            CoreCourseModulePrefetchDelegate.setOnProgress(downloadId, (data) => {
                sectionWithStatus.count = data.count;
                sectionWithStatus.total = data.total;
            });
        }

        return { statusData: result, section: sectionWithStatus };
    }

    /**
     * Calculate the status of a list of sections, setting attributes to determine the icons/data to be shown.
     *
     * @param sections Sections to calculate their status.
     * @param courseId Course ID the sections belong to.
     * @param refresh True if it shouldn't use module status cache (slower).
     * @param checkUpdates Whether to use the WS to check updates. Defaults to true.
     * @return Promise resolved when the states are calculated.
     */
    async calculateSectionsStatus(
        sections: CoreCourseSection[],
        courseId: number,
        refresh?: boolean,
        checkUpdates: boolean = true,
    ): Promise<CoreCourseSectionWithStatus[]> {
        let allSectionsSection: CoreCourseSectionWithStatus | undefined;
        let allSectionsStatus = CoreConstants.NOT_DOWNLOADABLE;

        const promises = sections.map(async (section: CoreCourseSectionWithStatus) => {
            section.isCalculating = true;

            if (section.id === CoreCourseProvider.ALL_SECTIONS_ID) {
                // "All sections" section status is calculated using the status of the rest of sections.
                allSectionsSection = section;

                return;
            }

            try {
                const result = await this.calculateSectionStatus(section, courseId, refresh, checkUpdates);

                // Calculate "All sections" status.
                allSectionsStatus = CoreFilepool.determinePackagesStatus(allSectionsStatus, result.statusData.status);
            } finally {
                section.isCalculating = false;
            }
        });

        try {
            await Promise.all(promises);

            if (allSectionsSection) {
                // Set "All sections" data.
                allSectionsSection.downloadStatus = allSectionsStatus;
                allSectionsSection.canCheckUpdates = CoreCourseModulePrefetchDelegate.canCheckUpdates();
                allSectionsSection.isDownloading = allSectionsStatus === CoreConstants.DOWNLOADING;
            }

            return sections;
        } finally {
            if (allSectionsSection) {
                allSectionsSection.isCalculating = false;
            }
        }
    }

    /**
     * Show a confirm and prefetch a course. It will retrieve the sections and the course options if not provided.
     * This function will set the icon to "spinner" when starting and it will also set it back to the initial icon if the
     * user cancels. All the other updates of the icon should be made when CoreEvents.COURSE_STATUS_CHANGED is received.
     *
     * @param data An object where to store the course icon and title: "prefetchCourseIcon", "title" and "downloadSucceeded".
     * @param course Course to prefetch.
     * @param sections List of course sections.
     * @param courseHandlers List of course handlers.
     * @param menuHandlers List of course menu handlers.
     * @return Promise resolved when the download finishes, rejected if an error occurs or the user cancels.
     */
    async confirmAndPrefetchCourse(
        data: CorePrefetchStatusInfo,
        course: CoreCourseAnyCourseData,
        sections?: CoreCourseWSSection[],
        courseHandlers?: CoreCourseOptionsHandlerToDisplay[],
        menuHandlers?: CoreCourseOptionsMenuHandlerToDisplay[],
    ): Promise<void> {
        const initialIcon = data.icon;
        const initialStatus = data.status;
        const initialStatusTranslatable = data.statusTranslatable;
        const siteId = CoreSites.getCurrentSiteId();

        data.downloadSucceeded = false;
        data.icon = CoreConstants.ICON_DOWNLOADING;
        data.status = CoreConstants.DOWNLOADING;
        data.loading = true;
        data.statusTranslatable = 'core.downloading';

        try {
            // Get the sections first if needed.
            if (!sections) {
                sections = await CoreCourse.getSections(course.id, false, true);
            }

            // Confirm the download.
            await this.confirmDownloadSizeSection(course.id, undefined, sections, true);

            // User confirmed, get the course handlers if needed.
            if (!courseHandlers) {
                courseHandlers = await CoreCourseOptionsDelegate.getHandlersToDisplay(course);
            }
            if (!menuHandlers) {
                menuHandlers = await CoreCourseOptionsDelegate.getMenuHandlersToDisplay(course);
            }

            // Now we have all the data, download the course.
            await this.prefetchCourse(course, sections, courseHandlers, menuHandlers, siteId);

            // Download successful.
            data.downloadSucceeded = true;
            data.loading = false;
        } catch (error) {
            // User cancelled or there was an error.
            data.icon = initialIcon;
            data.status = initialStatus;
            data.statusTranslatable = initialStatusTranslatable;
            data.loading = false;

            throw error;
        }
    }

    /**
     * Confirm and prefetches a list of courses.
     *
     * @param courses List of courses to download.
     * @param onProgress Function to call everytime a course is downloaded.
     * @return Resolved when downloaded, rejected if error or canceled.
     */
    async confirmAndPrefetchCourses(
        courses: CoreEnrolledCourseDataWithExtraInfoAndOptions[],
        onProgress?: (data: CoreCourseCoursesProgress) => void,
    ): Promise<void> {
        const siteId = CoreSites.getCurrentSiteId();

        // Confirm the download without checking size because it could take a while.
        await CoreDomUtils.showConfirm(Translate.instant('core.areyousure'));

        const total = courses.length;
        let count = 0;

        const promises = courses.map((course) => {
            const subPromises: Promise<void>[] = [];
            let sections: CoreCourseWSSection[];
            let handlers: CoreCourseOptionsHandlerToDisplay[] = [];
            let menuHandlers: CoreCourseOptionsMenuHandlerToDisplay[] = [];
            let success = true;

            // Get the sections and the handlers.
            subPromises.push(CoreCourse.getSections(course.id, false, true).then((courseSections) => {
                sections = courseSections;

                return;
            }));

            subPromises.push(CoreCourseOptionsDelegate.getHandlersToDisplay(course).then((cHandlers) => {
                handlers = cHandlers;

                return;
            }));
            subPromises.push(CoreCourseOptionsDelegate.getMenuHandlersToDisplay(course).then((mHandlers) => {
                menuHandlers = mHandlers;

                return;
            }));

            return Promise.all(subPromises).then(() => this.prefetchCourse(course, sections, handlers, menuHandlers, siteId))
                .catch((error) => {
                    success = false;

                    throw error;
                }).finally(() => {
                // Course downloaded or failed, notify the progress.
                    count++;
                    if (onProgress) {
                        onProgress({ count: count, total: total, courseId: course.id, success: success });
                    }
                });
        });

        if (onProgress) {
            // Notify the start of the download.
            onProgress({ count: 0, total: total, success: true });
        }

        return CoreUtils.allPromises(promises);
    }

    /**
     * Show confirmation dialog and then remove a module files.
     *
     * @param module Module to remove the files.
     * @param courseId Course ID the module belongs to.
     * @param done Function to call when done. It will close the context menu.
     * @return Promise resolved when done.
     */
    async confirmAndRemoveFiles(module: CoreCourseWSModule, courseId: number, done?: () => void): Promise<void> {
        let modal: CoreIonLoadingElement | undefined;

        try {

            await CoreDomUtils.showDeleteConfirm('core.course.confirmdeletestoreddata');

            modal = await CoreDomUtils.showModalLoading();

            await this.removeModuleStoredData(module, courseId);

            done && done();

        } catch (error) {
            if (error) {
                CoreDomUtils.showErrorModal(error);
            }
        } finally {
            modal?.dismiss();
        }
    }

    /**
     * Calculate the size to download a section and show a confirm modal if needed.
     *
     * @param courseId Course ID the section belongs to.
     * @param section Section. If not provided, all sections.
     * @param sections List of sections. Used when downloading all the sections.
     * @param alwaysConfirm True to show a confirm even if the size isn't high, false otherwise.
     * @return Promise resolved if the user confirms or there's no need to confirm.
     */
    async confirmDownloadSizeSection(
        courseId: number,
        section?: CoreCourseWSSection,
        sections?: CoreCourseWSSection[],
        alwaysConfirm?: boolean,
    ): Promise<void> {
        let hasEmbeddedFiles = false;
        let sizeSum: CoreFileSizeSum = {
            size: 0,
            total: true,
        };

        if (!section && !sections) {
            throw new CoreError('Either section or list of sections needs to be supplied.');
        }

        // Calculate the size of the download.
        if (section && section.id != CoreCourseProvider.ALL_SECTIONS_ID) {
            sizeSum = await CoreCourseModulePrefetchDelegate.getDownloadSize(section.modules, courseId);

            // Check if the section has embedded files in the description.
            hasEmbeddedFiles = CoreFilepool.extractDownloadableFilesFromHtml(section.summary).length > 0;
        } else {
            await Promise.all(sections!.map(async (section) => {
                if (section.id == CoreCourseProvider.ALL_SECTIONS_ID) {
                    return;
                }

                const sectionSize = await CoreCourseModulePrefetchDelegate.getDownloadSize(section.modules, courseId);

                sizeSum.total = sizeSum.total && sectionSize.total;
                sizeSum.size += sectionSize.size;

                // Check if the section has embedded files in the description.
                if (!hasEmbeddedFiles && CoreFilepool.extractDownloadableFilesFromHtml(section.summary).length > 0) {
                    hasEmbeddedFiles = true;
                }
            }));
        }

        if (hasEmbeddedFiles) {
            sizeSum.total = false;
        }

        // Show confirm modal if needed.
        await CoreDomUtils.confirmDownloadSize(sizeSum, undefined, undefined, undefined, undefined, alwaysConfirm);
    }

    /**
     * Helper function to prefetch a module, showing a confirmation modal if the size is big.
     * This function is meant to be called from a context menu option. It will also modify some data like the prefetch icon.
     *
     * @param instance The component instance that has the context menu.
     * @param module Module to be prefetched
     * @param courseId Course ID the module belongs to.
     * @param done Function to call when done. It will close the context menu.
     * @return Promise resolved when done.
     */
    async contextMenuPrefetch(
        instance: ComponentWithContextMenu,
        module: CoreCourseWSModule,
        courseId: number,
        done?: () => void,
    ): Promise<void> {
        const initialIcon = instance.prefetchStatusIcon;
        instance.prefetchStatusIcon = CoreConstants.ICON_DOWNLOADING; // Show spinner since this operation might take a while.

        try {
            // We need to call getDownloadSize, the package might have been updated.
            const size = await CoreCourseModulePrefetchDelegate.getModuleDownloadSize(module, courseId, true);

            await CoreDomUtils.confirmDownloadSize(size);

            await CoreCourseModulePrefetchDelegate.prefetchModule(module, courseId, true);

            // Success, close menu.
            done && done();
        } catch (error) {
            instance.prefetchStatusIcon = initialIcon;

            if (!instance.isDestroyed) {
                CoreDomUtils.showErrorModalDefault(error, 'core.errordownloading', true);
            }
        }
    }

    /**
     * Create and return a section for "All sections".
     *
     * @return Created section.
     */
    createAllSectionsSection(): CoreCourseSection {
        return {
            id: CoreCourseProvider.ALL_SECTIONS_ID,
            name: Translate.instant('core.course.allsections'),
            hasContent: true,
            summary: '',
            summaryformat: 1,
            modules: [],
        };
    }

    /**
     * Determine the status of a list of courses.
     *
     * @param courses Courses
     * @return Promise resolved with the status.
     */
    async determineCoursesStatus(courses: CoreCourseBasicData[]): Promise<string> {
        // Get the status of each course.
        const promises: Promise<string>[] = [];
        const siteId = CoreSites.getCurrentSiteId();

        courses.forEach((course) => {
            promises.push(CoreCourse.getCourseStatus(course.id, siteId));
        });

        const statuses = await Promise.all(promises);

        // Now determine the status of the whole list.
        let status = statuses[0];
        const filepool = CoreFilepool.instance;
        for (let i = 1; i < statuses.length; i++) {
            status = filepool.determinePackagesStatus(status, statuses[i]);
        }

        return status;
    }

    /**
     * Convenience function to open a module main file, downloading the package if needed.
     * This is meant for modules like mod_resource.
     *
     * @param module The module to download.
     * @param courseId The course ID of the module.
     * @param component The component to link the files to.
     * @param componentId An ID to use in conjunction with the component.
     * @param files List of files of the module. If not provided, use module.contents.
     * @param siteId The site ID. If not defined, current site.
     * @param options Options to open the file.
     * @return Resolved on success.
     */
    async downloadModuleAndOpenFile(
        module: CoreCourseWSModule,
        courseId: number,
        component?: string,
        componentId?: string | number,
        files?: CoreCourseModuleContentFile[],
        siteId?: string,
        options: CoreUtilsOpenFileOptions = {},
    ): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        if (!files || !files.length) {
            // Make sure that module contents are loaded.
            await CoreCourse.loadModuleContents(module, courseId);

            files = module.contents;
        }

        if (!files || !files.length) {
            throw new CoreError(Translate.instant('core.filenotfound'));
        }

        const mainFile = files[0];

        if (!CoreFileHelper.isOpenableInApp(mainFile)) {
            await CoreFileHelper.showConfirmOpenUnsupportedFile();
        }

        const site = await CoreSites.getSite(siteId);

        // Check if the file should be opened in browser.
        if (CoreFileHelper.shouldOpenInBrowser(mainFile)) {
            return this.openModuleFileInBrowser(mainFile.fileurl, site, module, courseId, component, componentId, files, options);
        }

        // File shouldn't be opened in browser. Download the module if it needs to be downloaded.
        const result = await this.downloadModuleWithMainFileIfNeeded(
            module,
            courseId,
            component || '',
            componentId,
            files,
            siteId,
            options,
        );

        if (CoreUrlUtils.isLocalFileUrl(result.path)) {
            return CoreUtils.openFile(result.path, options);
        }

        /* In iOS, if we use the same URL in embedded browser and background download then the download only
        downloads a few bytes (cached ones). Add a hash to the URL so both URLs are different. */
        result.path = result.path + '#moodlemobile-embedded';

        try {
            await CoreUtils.openOnlineFile(result.path);
        } catch (error) {
            // Error opening the file, some apps don't allow opening online files.
            if (!CoreFile.isAvailable()) {
                throw error;
            } else if (result.status === CoreConstants.DOWNLOADING) {
                throw new CoreError(Translate.instant('core.erroropenfiledownloading'));
            }

            let path: string | undefined;
            if (result.status === CoreConstants.NOT_DOWNLOADED) {
                // Not downloaded, download it now and return the local file.
                await this.downloadModule(module, courseId, component, componentId, files, siteId);

                path = await CoreFilepool.getInternalUrlByUrl(siteId, mainFile.fileurl);
            } else {
                // File is outdated or stale and can't be opened in online, return the local URL.
                path = await CoreFilepool.getInternalUrlByUrl(siteId, mainFile.fileurl);
            }

            await CoreUtils.openFile(path, options);
        }
    }

    /**
     * Convenience function to open a module main file in case it needs to be opened in browser.
     *
     * @param fileUrl URL of the main file.
     * @param site Site instance.
     * @param module The module to download.
     * @param courseId The course ID of the module.
     * @param component The component to link the files to.
     * @param componentId An ID to use in conjunction with the component.
     * @param files List of files of the module. If not provided, use module.contents.
     * @param options Options to open the file. Only used if not opened in browser.
     * @return Resolved on success.
     */
    protected async openModuleFileInBrowser(
        fileUrl: string,
        site: CoreSite,
        module: CoreCourseWSModule,
        courseId: number,
        component?: string,
        componentId?: string | number,
        files?: CoreCourseModuleContentFile[],
        options: CoreUtilsOpenFileOptions = {},
    ): Promise<void> {
        if (!CoreApp.isOnline()) {
            // Not online, get the offline file. It will fail if not found.
            let path: string | undefined;
            try {
                path = await CoreFilepool.getInternalUrlByUrl(site.getId(), fileUrl);
            } catch {
                throw new CoreNetworkError();
            }

            return CoreUtils.openFile(path, options);
        }

        // Open in browser.
        let fixedUrl = await site.checkAndFixPluginfileURL(fileUrl);

        fixedUrl = fixedUrl.replace('&offline=1', '');
        // Remove forcedownload when followed by another param.
        fixedUrl = fixedUrl.replace(/forcedownload=\d+&/, '');
        // Remove forcedownload when not followed by any param.
        fixedUrl = fixedUrl.replace(/[?|&]forcedownload=\d+/, '');

        CoreUtils.openInBrowser(fixedUrl);

        if (CoreFile.isAvailable()) {
            // Download the file if needed (file outdated or not downloaded).
            // Download will be in background, don't return the promise.
            this.downloadModule(module, courseId, component, componentId, files, site.getId());
        }
    }

    /**
     * Convenience function to download a module that has a main file and return the local file's path and other info.
     * This is meant for modules like mod_resource.
     *
     * @param module The module to download.
     * @param courseId The course ID of the module.
     * @param component The component to link the files to.
     * @param componentId An ID to use in conjunction with the component.
     * @param files List of files of the module. If not provided, use module.contents.
     * @param siteId The site ID. If not defined, current site.
     * @param options Options to open the file.
     * @return Promise resolved when done.
     */
    async downloadModuleWithMainFileIfNeeded(
        module: CoreCourseWSModule,
        courseId: number,
        component: string,
        componentId?: string | number,
        files?: CoreCourseModuleContentFile[],
        siteId?: string,
        options: CoreUtilsOpenFileOptions = {},
    ): Promise<{ fixedUrl: string; path: string; status?: string }> {

        siteId = siteId || CoreSites.getCurrentSiteId();

        if (!files || !files.length) {
            // Module not valid, stop.
            throw new CoreError('File list not supplied.');
        }

        const mainFile = files[0];
        const site = await CoreSites.getSite(siteId);

        const fixedUrl = await site.checkAndFixPluginfileURL(mainFile.fileurl);

        if (!CoreFile.isAvailable()) {
            return {
                path: fixedUrl, // Use the online URL.
                fixedUrl,
            };
        }

        // The file system is available.
        const status = await CoreFilepool.getPackageStatus(siteId, component, componentId);

        let path = '';

        if (status === CoreConstants.DOWNLOADING) {
            // Use the online URL.
            path = fixedUrl;
        } else if (status === CoreConstants.DOWNLOADED) {
            try {
                // Get the local file URL.
                path = await CoreFilepool.getInternalUrlByUrl(siteId, mainFile.fileurl);
            } catch (error){
                // File not found, mark the module as not downloaded.
                await CoreFilepool.storePackageStatus(siteId, CoreConstants.NOT_DOWNLOADED, component, componentId);
            }
        }

        if (!path) {
            path = await this.downloadModuleWithMainFile(
                module,
                courseId,
                fixedUrl,
                files,
                status,
                component,
                componentId,
                siteId,
                options,
            );
        }

        return {
            path,
            fixedUrl,
            status,
        };
    }

    /**
     * Convenience function to download a module that has a main file and return the local file's path and other info.
     * This is meant for modules like mod_resource.
     *
     * @param module The module to download.
     * @param courseId The course ID of the module.
     * @param fixedUrl Main file's fixed URL.
     * @param files List of files of the module.
     * @param status The package status.
     * @param component The component to link the files to.
     * @param componentId An ID to use in conjunction with the component.
     * @param siteId The site ID. If not defined, current site.
     * @param options Options to open the file.
     * @return Promise resolved when done.
     */
    protected async downloadModuleWithMainFile(
        module: CoreCourseWSModule,
        courseId: number,
        fixedUrl: string,
        files: CoreCourseModuleContentFile[],
        status: string,
        component?: string,
        componentId?: string | number,
        siteId?: string,
        options: CoreUtilsOpenFileOptions = {},
    ): Promise<string> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const isOnline = CoreApp.isOnline();
        const mainFile = files[0];
        const timemodified = mainFile.timemodified || 0;

        if (!isOnline && status === CoreConstants.NOT_DOWNLOADED) {
            // Not downloaded and we're offline, reject.
            throw new CoreNetworkError();
        }

        const shouldDownloadFirst = await CoreFilepool.shouldDownloadFileBeforeOpen(fixedUrl, mainFile.filesize, options);

        if (shouldDownloadFirst) {
            // Download and then return the local URL.
            await this.downloadModule(module, courseId, component, componentId, files, siteId);

            return CoreFilepool.getInternalUrlByUrl(siteId, mainFile.fileurl);
        }

        // Start the download if in wifi, but return the URL right away so the file is opened.
        if (CoreApp.isWifi()) {
            this.downloadModule(module, courseId, component, componentId, files, siteId);
        }

        if (!CoreFileHelper.isStateDownloaded(status) || isOnline) {
            // Not downloaded or online, return the online URL.
            return fixedUrl;
        } else {
            // Outdated but offline, so we return the local URL. Use getUrlByUrl so it's added to the queue.
            return CoreFilepool.getUrlByUrl(
                siteId,
                mainFile.fileurl,
                component,
                componentId,
                timemodified,
                false,
                false,
                mainFile,
            );
        }
    }

    /**
     * Convenience function to download a module.
     *
     * @param module The module to download.
     * @param courseId The course ID of the module.
     * @param component The component to link the files to.
     * @param componentId An ID to use in conjunction with the component.
     * @param files List of files of the module. If not provided, use module.contents.
     * @param siteId The site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async downloadModule(
        module: CoreCourseWSModule,
        courseId: number,
        component?: string,
        componentId?: string | number,
        files?: CoreCourseModuleContentFile[],
        siteId?: string,
    ): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const prefetchHandler = CoreCourseModulePrefetchDelegate.getPrefetchHandlerFor(module);

        if (prefetchHandler) {
            // Use the prefetch handler to download the module.
            if (prefetchHandler.download) {
                return await prefetchHandler.download(module, courseId);
            }

            return await prefetchHandler.prefetch(module, courseId, true);
        }

        // There's no prefetch handler for the module, just download the files.
        files = files || module.contents;

        await CoreFilepool.downloadOrPrefetchFiles(siteId, files, false, false, component, componentId);
    }

    /**
     * Fill the Context Menu for a certain module.
     *
     * @param instance The component instance that has the context menu.
     * @param module Module to be prefetched
     * @param courseId Course ID the module belongs to.
     * @param invalidateCache Invalidates the cache first.
     * @param component Component of the module.
     * @return Promise resolved when done.
     */
    async fillContextMenu(
        instance: ComponentWithContextMenu,
        module: CoreCourseWSModule,
        courseId: number,
        invalidateCache?: boolean,
        component?: string,
    ): Promise<void> {
        const siteId = CoreSites.getCurrentSiteId();

        const moduleInfo = await this.getModulePrefetchInfo(module, courseId, invalidateCache, component);

        instance.size = moduleInfo.size && moduleInfo.size > 0 ? moduleInfo.sizeReadable! : '';
        instance.prefetchStatusIcon = moduleInfo.statusIcon;
        instance.prefetchStatus = moduleInfo.status;

        if (moduleInfo.status != CoreConstants.NOT_DOWNLOADABLE) {
            // Module is downloadable, get the text to display to prefetch.
            if (moduleInfo.downloadTime && moduleInfo.downloadTime > 0) {
                instance.prefetchText = Translate.instant('core.lastdownloaded') + ': ' + moduleInfo.downloadTimeReadable;
            } else {
                // Module not downloaded, show a default text.
                instance.prefetchText = Translate.instant('core.download');
            }
        }

        if (moduleInfo.status == CoreConstants.DOWNLOADING) {
            // Set this to empty to prevent "remove file" option showing up while downloading.
            instance.size = '';
        }

        if (!instance.contextMenuStatusObserver && component) {
            instance.contextMenuStatusObserver = CoreEvents.on(
                CoreEvents.PACKAGE_STATUS_CHANGED,
                (data) => {
                    if (data.componentId == module.id && data.component == component) {
                        this.fillContextMenu(instance, module, courseId, false, component);
                    }
                },
                siteId,
            );
        }

        if (!instance.contextFileStatusObserver && component) {
            // Debounce the update size function to prevent too many calls when downloading or deleting a whole activity.
            const debouncedUpdateSize = CoreUtils.debounce(async () => {
                const moduleSize = await CoreCourseModulePrefetchDelegate.getModuleStoredSize(module, courseId);

                instance.size = moduleSize > 0 ? CoreTextUtils.bytesToSize(moduleSize, 2) : '';
            }, 1000);

            instance.contextFileStatusObserver = CoreEvents.on(
                CoreEvents.COMPONENT_FILE_ACTION,
                (data) => {
                    if (data.component != component || data.componentId != module.id) {
                        // The event doesn't belong to this component, ignore.
                        return;
                    }

                    if (!CoreFilepool.isFileEventDownloadedOrDeleted(data)) {
                        return;
                    }

                    // Update the module size.
                    debouncedUpdateSize();
                },
                siteId,
            );
        }
    }

    /**
     * Get a course. It will first check the user courses, and fallback to another WS if not enrolled.
     *
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved with the course.
     */
    async getCourse(
        courseId: number,
        siteId?: string,
    ): Promise<{ enrolled: boolean; course: CoreCourseAnyCourseData }> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        let course: CoreCourseAnyCourseData;

        // Try with enrolled courses first.
        try {
            course = await CoreCourses.getUserCourse(courseId, false, siteId);

            return ({ enrolled: true, course: course });
        } catch {
            // Not enrolled or an error happened. Try to use another WebService.
        }

        const available = await CoreCourses.isGetCoursesByFieldAvailableInSite(siteId);

        if (available) {
            course = await CoreCourses.getCourseByField('id', courseId, siteId);
        } else {
            course = await CoreCourses.getCourse(courseId, siteId);
        }

        return ({ enrolled: false, course: course });
    }

    /**
     * Get a course, wait for any course format plugin to load, and open the course page. It basically chains the functions
     * getCourse and openCourse.
     *
     * @param courseId Course ID.
     * @param params Other params to pass to the course page.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async getAndOpenCourse(courseId: number, params?: Params, siteId?: string): Promise<void> {
        const modal = await CoreDomUtils.showModalLoading();

        let course: CoreCourseAnyCourseData | { id: number };

        try {
            const data = await this.getCourse(courseId, siteId);

            course = data.course;
        } catch {
            // Cannot get course, return a "fake".
            course = { id: courseId };
        }

        modal?.dismiss();

        return this.openCourse(course, params, siteId);
    }

    /**
     * Check if the course has a block with that name.
     *
     * @param courseId Course ID.
     * @param name Block name to search.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved with true if the block exists or false otherwise.
     * @since 3.3
     */
    async hasABlockNamed(courseId: number, name: string, siteId?: string): Promise<boolean> {
        try {
            const blocks = await CoreCourse.getCourseBlocks(courseId, siteId);

            return blocks.some((block) => block.name == name);
        } catch {
            return false;
        }
    }

    /**
     * Initialize the prefetch icon for selected courses.
     *
     * @param courses Courses array to get info from.
     * @param prefetch Prefetch information.
     * @param minCourses Min course to show icon.
     * @return Resolved with the prefetch information updated when done.
     */
    async initPrefetchCoursesIcons(
        courses: CoreCourseBasicData[],
        prefetch: CorePrefetchStatusInfo,
        minCourses: number = 2,
    ): Promise<CorePrefetchStatusInfo> {
        if (!courses || courses.length < minCourses) {
            // Not enough courses.
            prefetch.icon = '';

            return prefetch;
        }

        const status = await this.determineCoursesStatus(courses);

        prefetch = this.getCoursePrefetchStatusInfo(status);

        if (prefetch.loading) {
            // It seems all courses are being downloaded, show a download button instead.
            prefetch.icon = CoreConstants.ICON_NOT_DOWNLOADED;
        }

        return prefetch;
    }

    /**
     * Load offline completion into a list of sections.
     * This should be used in 3.6 sites or higher, where the course contents already include the completion.
     *
     * @param courseId The course to get the completion.
     * @param sections List of sections of the course.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async loadOfflineCompletion(courseId: number, sections: CoreCourseSection[], siteId?: string): Promise<void> {
        const offlineCompletions = await CoreCourseOffline.getCourseManualCompletions(courseId, siteId);

        if (!offlineCompletions || !offlineCompletions.length) {
            // No offline completion.
            return;
        }

        const totalOffline = offlineCompletions.length;
        let loaded = 0;
        const offlineCompletionsMap = CoreUtils.arrayToObject(offlineCompletions, 'cmid');
        // Load the offline data in the modules.
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            if (!section.modules || !section.modules.length) {
                // Section has no modules, ignore it.
                continue;
            }

            for (let j = 0; j < section.modules.length; j++) {
                const module = section.modules[j];
                const offlineCompletion = offlineCompletionsMap[module.id];

                if (offlineCompletion && typeof module.completiondata != 'undefined' &&
                    offlineCompletion.timecompleted >= module.completiondata.timecompleted * 1000) {
                    // The module has offline completion. Load it.
                    module.completiondata.state = offlineCompletion.completed;
                    module.completiondata.offline = true;

                    // If all completions have been loaded, stop.
                    loaded++;
                    if (loaded == totalOffline) {
                        break;
                    }
                }
            }
        }
    }

    /**
     * Load offline completion for a certain module.
     * This should be used in 3.6 sites or higher, where the course contents already include the completion.
     *
     * @param courseId The course to get the completion.
     * @param mmodule The module.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async loadModuleOfflineCompletion(courseId: number, module: CoreCourseModule, siteId?: string): Promise<void> {
        if (!module.completiondata) {
            return;
        }

        const offlineCompletions = await CoreCourseOffline.getCourseManualCompletions(courseId, siteId);

        const offlineCompletion = offlineCompletions.find(completion => completion.cmid == module.id);

        if (offlineCompletion && offlineCompletion.timecompleted >= module.completiondata.timecompleted * 1000) {
            // The module has offline completion. Load it.
            module.completiondata.state = offlineCompletion.completed;
            module.completiondata.offline = true;
        }
    }

    /**
     * Prefetch all the courses in the array.
     *
     * @param courses Courses array to prefetch.
     * @param prefetch Prefetch information to be updated.
     * @return Promise resolved when done.
     */
    async prefetchCourses(
        courses: CoreEnrolledCourseDataWithExtraInfoAndOptions[],
        prefetch: CorePrefetchStatusInfo,
    ): Promise<void> {
        prefetch.loading = true;
        prefetch.icon = CoreConstants.ICON_DOWNLOADING;
        prefetch.badge = '';

        try {
            await this.confirmAndPrefetchCourses(courses, (progress) => {
                prefetch.badge = progress.count + ' / ' + progress.total;
                prefetch.badgeA11yText = Translate.instant('core.course.downloadcoursesprogressdescription', progress);
                prefetch.count = progress.count;
                prefetch.total = progress.total;
            });
            prefetch.icon = CoreConstants.ICON_OUTDATED;
        } finally {
            prefetch.loading = false;
            prefetch.badge = '';
        }
    }

    /**
     * Get a course download promise (if any).
     *
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     * @return Download promise, undefined if not found.
     */
    getCourseDownloadPromise(courseId: number, siteId?: string): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        return this.courseDwnPromises[siteId] && this.courseDwnPromises[siteId][courseId];
    }

    /**
     * Get a course status icon and the langkey to use as a title.
     *
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved with the icon name and the title key.
     */
    async getCourseStatusIconAndTitle(courseId: number, siteId?: string): Promise<CorePrefetchStatusInfo> {
        const status = await CoreCourse.getCourseStatus(courseId, siteId);

        return this.getCoursePrefetchStatusInfo(status);
    }

    /**
     * Get a course status icon and the langkey to use as a title from status.
     *
     * @param status Course status.
     * @return Prefetch status info.
     */
    getCoursePrefetchStatusInfo(status: string): CorePrefetchStatusInfo {
        const prefetchStatus: CorePrefetchStatusInfo = {
            status: status,
            icon: this.getPrefetchStatusIcon(status, false),
            statusTranslatable: '',
            loading: false,
        };

        if (status == CoreConstants.DOWNLOADED) {
            // Always show refresh icon, we cannot know if there's anything new in course options.
            prefetchStatus.statusTranslatable = 'core.course.refreshcourse';
        } else if (status == CoreConstants.DOWNLOADING) {
            prefetchStatus.statusTranslatable = 'core.downloading';
            prefetchStatus.loading = true;
        } else {
            prefetchStatus.statusTranslatable = 'core.course.downloadcourse';
        }

        return prefetchStatus;
    }

    /**
     * Get the icon given the status and if trust the download status.
     *
     * @param status Status constant.
     * @param trustDownload True to show download success, false to show an outdated status when downloaded.
     * @return Icon name.
     */
    getPrefetchStatusIcon(status: string, trustDownload: boolean = false): string {
        if (status == CoreConstants.NOT_DOWNLOADED) {
            return CoreConstants.ICON_NOT_DOWNLOADED;
        }
        if (status == CoreConstants.OUTDATED || (status == CoreConstants.DOWNLOADED && !trustDownload)) {
            return CoreConstants.ICON_OUTDATED;
        }
        if (status == CoreConstants.DOWNLOADED && trustDownload) {
            return CoreConstants.ICON_DOWNLOADED;
        }
        if (status == CoreConstants.DOWNLOADING) {
            return CoreConstants.ICON_DOWNLOADING;
        }

        return CoreConstants.ICON_DOWNLOADING;
    }

    /**
     * Get the course ID from a module instance ID, showing an error message if it can't be retrieved.
     *
     * @param id Instance ID.
     * @param module Name of the module. E.g. 'glossary'.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved with the module's course ID.
     */
    async getModuleCourseIdByInstance(id: number, module: string, siteId?: string): Promise<number> {
        try {
            const cm = await CoreCourse.getModuleBasicInfoByInstance(id, module, siteId);

            return cm.course;
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'core.course.errorgetmodule', true);

            throw error;
        }
    }

    /**
     * Get prefetch info for a module.
     *
     * @param module Module to get the info from.
     * @param courseId Course ID the section belongs to.
     * @param invalidateCache Invalidates the cache first.
     * @param component Component of the module.
     * @return Promise resolved with the info.
     */
    async getModulePrefetchInfo(
        module: CoreCourseWSModule,
        courseId: number,
        invalidateCache?: boolean,
        component?: string,
    ): Promise<CoreCourseModulePrefetchInfo> {
        const moduleInfo: CoreCourseModulePrefetchInfo = {};
        const siteId = CoreSites.getCurrentSiteId();

        if (invalidateCache) {
            CoreCourseModulePrefetchDelegate.invalidateModuleStatusCache(module);
        }

        const results = await Promise.all([
            CoreCourseModulePrefetchDelegate.getModuleStoredSize(module, courseId),
            CoreCourseModulePrefetchDelegate.getModuleStatus(module, courseId),
            CoreUtils.ignoreErrors(CoreFilepool.getPackageData(siteId, component || '', module.id)),
        ]);

        // Treat stored size.
        moduleInfo.size = results[0];
        moduleInfo.sizeReadable = CoreTextUtils.bytesToSize(results[0], 2);

        // Treat module status.
        moduleInfo.status = results[1];
        switch (results[1]) {
            case CoreConstants.NOT_DOWNLOADED:
                moduleInfo.statusIcon = CoreConstants.ICON_NOT_DOWNLOADED;
                break;
            case CoreConstants.DOWNLOADING:
                moduleInfo.statusIcon = CoreConstants.ICON_DOWNLOADING;
                break;
            case CoreConstants.OUTDATED:
                moduleInfo.statusIcon = CoreConstants.ICON_OUTDATED;
                break;
            case CoreConstants.DOWNLOADED:
                if (!CoreCourseModulePrefetchDelegate.canCheckUpdates()) {
                    moduleInfo.statusIcon = CoreConstants.ICON_OUTDATED;
                }
                break;
            default:
                moduleInfo.statusIcon = '';
                break;
        }

        // Treat download time.
        if (!results[2] || !results[2].downloadTime || !CoreFileHelper.isStateDownloaded(results[2].status || '')) {
            // Not downloaded.
            moduleInfo.downloadTime = 0;

            return moduleInfo;
        }

        const now = CoreTimeUtils.timestamp();
        moduleInfo.downloadTime = results[2].downloadTime;
        if (now - results[2].downloadTime < 7 * 86400) {
            moduleInfo.downloadTimeReadable = moment(results[2].downloadTime * 1000).fromNow();
        } else {
            moduleInfo.downloadTimeReadable = moment(results[2].downloadTime * 1000).calendar();
        }

        return moduleInfo;
    }

    /**
     * Get the download ID of a section. It's used to interact with CoreCourseModulePrefetchDelegate.
     *
     * @param section Section.
     * @return Section download ID.
     */
    getSectionDownloadId(section: {id: number}): string {
        return 'Section-' + section.id;
    }

    /**
     * Navigate to a module using instance ID and module name.
     *
     * @param instanceId Activity instance ID.
     * @param modName Module name of the activity.
     * @param siteId Site ID. If not defined, current site.
     * @param courseId Course ID. If not defined we'll try to retrieve it from the site.
     * @param sectionId Section the module belongs to. If not defined we'll try to retrieve it from the site.
     * @param useModNameToGetModule If true, the app will retrieve all modules of this type with a single WS call. This reduces the
     *                              number of WS calls, but it isn't recommended for modules that can return a lot of contents.
     * @param modParams Params to pass to the module
     * @return Promise resolved when done.
     */
    async navigateToModuleByInstance(
        instanceId: number,
        modName: string,
        siteId?: string,
        courseId?: number,
        sectionId?: number,
        useModNameToGetModule: boolean = false,
        modParams?: Params,
    ): Promise<void> {

        const modal = await CoreDomUtils.showModalLoading();

        try {
            const module = await CoreCourse.getModuleBasicInfoByInstance(instanceId, modName, siteId);

            this.navigateToModule(
                module.id,
                siteId,
                module.course,
                sectionId,
                useModNameToGetModule ? modName : undefined,
                modParams,
            );
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'core.course.errorgetmodule', true);
        } finally {
            // Just in case. In fact we need to dismiss the modal before showing a toast or error message.
            modal.dismiss();
        }
    }

    /**
     * Navigate to a module.
     *
     * @param moduleId Module's ID.
     * @param siteId Site ID. If not defined, current site.
     * @param courseId Course ID. If not defined we'll try to retrieve it from the site.
     * @param sectionId Section the module belongs to. If not defined we'll try to retrieve it from the site.
     * @param modName If set, the app will retrieve all modules of this type with a single WS call. This reduces the
     *                number of WS calls, but it isn't recommended for modules that can return a lot of contents.
     * @param modParams Params to pass to the module
     * @return Promise resolved when done.
     */
    async navigateToModule(
        moduleId: number,
        siteId?: string,
        courseId?: number,
        sectionId?: number,
        modName?: string,
        modParams?: Params,
    ): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const modal = await CoreDomUtils.showModalLoading();

        try {
            if (!courseId) {
                // We don't have courseId.
                const module = await CoreCourse.getModuleBasicInfo(moduleId, siteId);

                courseId = module.course;
                sectionId = module.section;
            } else if (!sectionId) {
                // We don't have sectionId but we have courseId.
                sectionId = await CoreCourse.getModuleSectionId(moduleId, siteId);
            }

            // Get the site.
            const site = await CoreSites.getSite(siteId);

            // Get the module.
            const module = <CoreCourseModule>
                await CoreCourse.getModule(moduleId, courseId, sectionId, false, false, siteId, modName);

            if (CoreSites.getCurrentSiteId() == site.getId()) {
                // Try to use the module's handler to navigate cleanly.
                module.handlerData = CoreCourseModuleDelegate.getModuleDataFor(
                    module.modname,
                    module,
                    courseId,
                    sectionId,
                    false,
                );

                if (module.handlerData?.action) {
                    modal.dismiss();

                    return module.handlerData.action(new Event('click'), module, courseId, { params: modParams });
                }
            }

            this.logger.warn('navCtrl was not passed to navigateToModule by the link handler for ' + module.modname);

            const params = {
                course: { id: courseId },
                module: module,
                sectionId: sectionId,
                modParams: modParams,
            };

            if (courseId == site.getSiteHomeId()) {
                // Check if site home is available.
                const isAvailable = await CoreSiteHome.isAvailable();

                if (isAvailable) {
                    await CoreNavigator.navigateToSitePath(CoreSiteHomeHomeHandlerService.PAGE_NAME, { params, siteId });

                    return;
                }
            }

            modal.dismiss();

            await this.getAndOpenCourse(courseId, params, siteId);
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'core.course.errorgetmodule', true);
        } finally {
            modal.dismiss();
        }
    }

    /**
     * Open a module.
     *
     * @param module The module to open.
     * @param courseId The course ID of the module.
     * @param sectionId The section ID of the module.
     * @param modParams Params to pass to the module
     * @param True if module can be opened, false otherwise.
     */
    openModule(module: CoreCourseModule, courseId: number, sectionId?: number, modParams?: Params): boolean {
        if (!module.handlerData) {
            module.handlerData = CoreCourseModuleDelegate.getModuleDataFor(
                module.modname,
                module,
                courseId,
                sectionId,
                false,
            );
        }

        if (module.handlerData?.action) {
            module.handlerData.action(new Event('click'), module, courseId, { animated: false, params: modParams });

            return true;
        }

        return false;
    }

    /**
     * Prefetch all the activities in a course and also the course addons.
     *
     * @param course The course to prefetch.
     * @param sections List of course sections.
     * @param courseHandlers List of course options handlers.
     * @param courseMenuHandlers List of course menu handlers.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when the download finishes.
     */
    async prefetchCourse(
        course: CoreCourseAnyCourseData,
        sections: CoreCourseWSSection[],
        courseHandlers: CoreCourseOptionsHandlerToDisplay[],
        courseMenuHandlers: CoreCourseOptionsMenuHandlerToDisplay[],
        siteId?: string,
    ): Promise<void> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        if (this.courseDwnPromises[siteId] && this.courseDwnPromises[siteId][course.id]) {
            // There's already a download ongoing for this course, return the promise.
            return this.courseDwnPromises[siteId][course.id];
        } else if (!this.courseDwnPromises[siteId]) {
            this.courseDwnPromises[siteId] = {};
        }

        // First of all, mark the course as being downloaded.
        this.courseDwnPromises[siteId][course.id] = CoreCourse.setCourseStatus(
            course.id,
            CoreConstants.DOWNLOADING,
            siteId,
        ).then(async () => {

            const promises: Promise<unknown>[] = [];

            // Prefetch all the sections. If the first section is "All sections", use it. Otherwise, use a fake "All sections".
            let allSectionsSection: CoreCourseSection = sections[0];
            if (sections[0].id != CoreCourseProvider.ALL_SECTIONS_ID) {
                allSectionsSection = this.createAllSectionsSection();
            }
            promises.push(this.prefetchSection(allSectionsSection, course.id, sections));

            // Prefetch course options.
            courseHandlers.forEach((handler) => {
                if (handler.prefetch) {
                    promises.push(handler.prefetch(course));
                }
            });
            courseMenuHandlers.forEach((handler) => {
                if (handler.prefetch) {
                    promises.push(handler.prefetch(course));
                }
            });

            // Prefetch other data needed to render the course.
            if (CoreCourses.isGetCoursesByFieldAvailable()) {
                promises.push(CoreCourses.getCoursesByField('id', course.id));
            }

            const sectionWithModules = sections.find((section) => section.modules && section.modules.length > 0);
            if (!sectionWithModules || typeof sectionWithModules.modules[0].completion == 'undefined') {
                promises.push(CoreCourse.getActivitiesCompletionStatus(course.id));
            }

            promises.push(CoreFilterHelper.getFilters('course', course.id));

            await CoreUtils.allPromises(promises);

            // Download success, mark the course as downloaded.
            return CoreCourse.setCourseStatus(course.id, CoreConstants.DOWNLOADED, siteId);
        }).catch(async (error) => {
            // Error, restore previous status.
            await CoreCourse.setCoursePreviousStatus(course.id, siteId);

            throw error;
        }).finally(() => {
            delete this.courseDwnPromises[siteId!][course.id];
        });

        return this.courseDwnPromises[siteId][course.id];
    }

    /**
     * Helper function to prefetch a module, showing a confirmation modal if the size is big
     * and invalidating contents if refreshing.
     *
     * @param handler Prefetch handler to use.
     * @param module Module to download.
     * @param size Size to download.
     * @param courseId Course ID of the module.
     * @param refresh True if refreshing, false otherwise.
     * @return Promise resolved when downloaded.
     */
    async prefetchModule(
        handler: CoreCourseModulePrefetchHandler,
        module: CoreCourseWSModule,
        size: CoreFileSizeSum,
        courseId: number,
        refresh?: boolean,
    ): Promise<void> {
        // Show confirmation if needed.
        await CoreDomUtils.confirmDownloadSize(size);

        // Invalidate content if refreshing and download the data.
        if (refresh) {
            await CoreUtils.ignoreErrors(handler.invalidateContent(module.id, courseId));
        }

        await CoreCourseModulePrefetchDelegate.prefetchModule(module, courseId, true);
    }

    /**
     * Prefetch one section or all the sections.
     * If the section is "All sections" it will prefetch all the sections.
     *
     * @param section Section.
     * @param courseId Course ID the section belongs to.
     * @param sections List of sections. Used when downloading all the sections.
     * @return Promise resolved when the prefetch is finished.
     */
    async prefetchSection(
        section: CoreCourseSectionWithStatus,
        courseId: number,
        sections?: CoreCourseSectionWithStatus[],
    ): Promise<void> {
        if (section.id != CoreCourseProvider.ALL_SECTIONS_ID) {
            try {
                // Download only this section.
                await this.prefetchSingleSectionIfNeeded(section, courseId);
            } finally {
                // Calculate the status of the section that finished.
                await this.calculateSectionStatus(section, courseId, false, false);
            }

            return;
        }

        if (!sections) {
            throw new CoreError('List of sections is required when downloading all sections.');
        }

        // Download all the sections except "All sections".
        let allSectionsStatus = CoreConstants.NOT_DOWNLOADABLE;

        section.isDownloading = true;
        const promises = sections.map(async (section) => {
            if (section.id == CoreCourseProvider.ALL_SECTIONS_ID) {
                return;
            }

            try {
                await this.prefetchSingleSectionIfNeeded(section, courseId);
            } finally {
                // Calculate the status of the section that finished.
                const result = await this.calculateSectionStatus(section, courseId, false, false);

                // Calculate "All sections" status.
                allSectionsStatus = CoreFilepool.determinePackagesStatus(allSectionsStatus, result.statusData.status);
            }
        });

        try {
            await CoreUtils.allPromises(promises);

            // Set "All sections" data.
            section.downloadStatus = allSectionsStatus;
            section.canCheckUpdates = CoreCourseModulePrefetchDelegate.canCheckUpdates();
            section.isDownloading = allSectionsStatus === CoreConstants.DOWNLOADING;
        } finally {
            section.isDownloading = false;
        }
    }

    /**
     * Prefetch a certain section if it needs to be prefetched.
     * If the section is "All sections" it will be ignored.
     *
     * @param section Section to prefetch.
     * @param courseId Course ID the section belongs to.
     * @return Promise resolved when the section is prefetched.
     */
    protected async prefetchSingleSectionIfNeeded(section: CoreCourseSectionWithStatus, courseId: number): Promise<void> {
        if (section.id == CoreCourseProvider.ALL_SECTIONS_ID || section.hiddenbynumsections) {
            return;
        }

        const promises: Promise<void>[] = [];
        const siteId = CoreSites.getCurrentSiteId();

        section.isDownloading = true;

        // Download the modules.
        promises.push(this.syncModulesAndPrefetchSection(section, courseId));

        // Download the files in the section description.
        const introFiles = CoreFilepool.extractDownloadableFilesFromHtmlAsFakeFileObjects(section.summary);
        promises.push(CoreUtils.ignoreErrors(
            CoreFilepool.addFilesToQueue(siteId, introFiles, CoreCourseProvider.COMPONENT, courseId),
        ));

        try {
            await Promise.all(promises);
        } finally {
            section.isDownloading = false;
        }
    }

    /**
     * Sync modules in a section and prefetch them.
     *
     * @param section Section to prefetch.
     * @param courseId Course ID the section belongs to.
     * @return Promise resolved when the section is prefetched.
     */
    protected async syncModulesAndPrefetchSection(section: CoreCourseSectionWithStatus, courseId: number): Promise<void> {
        // Sync the modules first.
        await CoreCourseModulePrefetchDelegate.syncModules(section.modules, courseId);

        // Validate the section needs to be downloaded and calculate amount of modules that need to be downloaded.
        const result = await CoreCourseModulePrefetchDelegate.getModulesStatus(section.modules, courseId, section.id);

        if (result.status == CoreConstants.DOWNLOADED || result.status == CoreConstants.NOT_DOWNLOADABLE) {
            // Section is downloaded or not downloadable, nothing to do.
            return ;
        }

        await this.prefetchSingleSection(section, result, courseId);
    }

    /**
     * Start or restore the prefetch of a section.
     * If the section is "All sections" it will be ignored.
     *
     * @param section Section to download.
     * @param result Result of CoreCourseModulePrefetchDelegate.getModulesStatus for this section.
     * @param courseId Course ID the section belongs to.
     * @return Promise resolved when the section has been prefetched.
     */
    protected async prefetchSingleSection(
        section: CoreCourseSectionWithStatus,
        result: CoreCourseModulesStatus,
        courseId: number,
    ): Promise<void> {
        if (section.id == CoreCourseProvider.ALL_SECTIONS_ID) {
            return;
        }

        if (section.total && section.total > 0) {
            // Already being downloaded.
            return ;
        }

        // We only download modules with status notdownloaded, downloading or outdated.
        const modules = result[CoreConstants.OUTDATED].concat(result[CoreConstants.NOT_DOWNLOADED])
            .concat(result[CoreConstants.DOWNLOADING]);
        const downloadId = this.getSectionDownloadId(section);

        section.isDownloading = true;

        // Prefetch all modules to prevent incoeherences in download count and to download stale data not marked as outdated.
        await CoreCourseModulePrefetchDelegate.prefetchModules(downloadId, modules, courseId, (data) => {
            section.count = data.count;
            section.total = data.total;
        });
    }

    /**
     * Check if a section has content.
     *
     * @param section Section to check.
     * @return Whether the section has content.
     */
    sectionHasContent(section: CoreCourseWSSection): boolean {
        if (section.hiddenbynumsections) {
            return false;
        }

        return (typeof section.availabilityinfo != 'undefined' && section.availabilityinfo != '') ||
            section.summary != '' || (section.modules && section.modules.length > 0);
    }

    /**
     * Wait for any course format plugin to load, and open the course page.
     *
     * If the plugin's promise is resolved, the course page will be opened. If it is rejected, they will see an error.
     * If the promise for the plugin is still in progress when the user tries to open the course, a loader
     * will be displayed until it is complete, before the course page is opened. If the promise is already complete,
     * they will see the result immediately.
     *
     * @param course Course to open
     * @param params Params to pass to the course page.
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async openCourse(course: CoreCourseAnyCourseData | { id: number }, params?: Params, siteId?: string): Promise<void> {
        if (!siteId || siteId == CoreSites.getCurrentSiteId()) {
            // Current site, we can open the course.
            return CoreCourse.openCourse(course, params);
        } else {
            // We need to load the site first.
            params = params || {};
            Object.assign(params, { course: course });

            await CoreNavigator.navigateToSitePath(`course/${course.id}`, { siteId, params });
        }
    }

    /**
     * Delete course files.
     *
     * @param courseId Course id.
     * @return Promise to be resolved once the course files are deleted.
     */
    async deleteCourseFiles(courseId: number): Promise<void> {
        const sections = await CoreCourse.getSections(courseId);
        const modules = CoreArray.flatten(sections.map((section) => section.modules));

        await Promise.all(
            modules.map((module) => this.removeModuleStoredData(module, courseId)),
        );

        await CoreCourse.setCourseStatus(courseId, CoreConstants.NOT_DOWNLOADED);
    }

    /**
     * Remove module stored data.
     *
     * @param module Module to remove the files.
     * @param courseId Course ID the module belongs to.
     * @return Promise resolved when done.
     */
    async removeModuleStoredData(module: CoreCourseWSModule, courseId: number): Promise<void> {
        const promises: Promise<void>[] = [];

        promises.push(CoreCourseModulePrefetchDelegate.removeModuleFiles(module, courseId));

        const handler = CoreCourseModulePrefetchDelegate.getPrefetchHandlerFor(module);
        const site = CoreSites.getCurrentSite();
        if (handler && site) {
            promises.push(site.deleteComponentFromCache(handler.component, module.id));
        }

        await Promise.all(promises);
    }

    /**
     * Completion clicked.
     *
     * @param completion The completion.
     * @param event The click event.
     * @return Promise resolved with the result.
     */
    async changeManualCompletion(
        completion: CoreCourseModuleCompletionData,
        event?: Event,
    ): Promise<CoreStatusWithWarningsWSResponse | void> {
        if (!completion) {
            return;
        }

        if (typeof completion.cmid == 'undefined' || completion.tracking !== 1) {
            return;
        }

        event?.preventDefault();
        event?.stopPropagation();

        const modal = await CoreDomUtils.showModalLoading();
        completion.state = completion.state === 1 ? 0 : 1;

        try {
            const response = await CoreCourse.markCompletedManually(
                completion.cmid,
                completion.state === 1,
                completion.courseId!,
                completion.courseName,
            );

            if (response.offline) {
                completion.offline = true;
            }

            return response;
        } catch (error) {
            completion.state = completion.state === 1 ? 0 : 1;
            CoreDomUtils.showErrorModalDefault(error, 'core.errorchangecompletion', true);
        } finally {
            modal.dismiss();
        }
    }

}

export const CoreCourseHelper = makeSingleton(CoreCourseHelperProvider);

/**
 * Section with calculated data.
 */
export type CoreCourseSection = Omit<CoreCourseWSSection, 'modules'> & {
    hasContent?: boolean;
    modules: CoreCourseModule[];
};

/**
 * Section with data about prefetch.
 */
export type CoreCourseSectionWithStatus = CoreCourseSection & {
    downloadStatus?: string; // Section status.
    canCheckUpdates?: boolean; // Whether can check updates.
    isDownloading?: boolean; // Whether section is being downloaded.
    total?: number; // Total of modules being downloaded.
    count?: number; // Number of downloaded modules.
    isCalculating?: boolean; // Whether status is being calculated.
};

/**
 * Module with calculated data.
 */
export type CoreCourseModule = Omit<CoreCourseWSModule, 'completiondata'> & {
    isStealth?: boolean;
    handlerData?: CoreCourseModuleHandlerData;
    completiondata?: CoreCourseModuleCompletionData;
};

/**
 * Module completion with calculated data.
 */
export type CoreCourseModuleCompletionData = CoreCourseModuleWSCompletionData & {
    courseId?: number;
    courseName?: string;
    tracking?: number;
    cmid?: number;
    offline?: boolean;
};

type ComponentWithContextMenu = {
    prefetchStatusIcon?: string;
    isDestroyed?: boolean;
    size?: string;
    prefetchStatus?: string;
    prefetchText?: string;
    contextMenuStatusObserver?: CoreEventObserver;
    contextFileStatusObserver?: CoreEventObserver;
};
