// (C) Copyright 2015 Martin Dougiamas
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

angular.module('mm.addons.mod_imscp')

/**
 * IMSCP index controller.
 *
 * @module mm.addons.mod_imscp
 * @ngdoc controller
 * @name mmaModImscpIndexCtrl
 */
.controller('mmaModImscpIndexCtrl', function($scope, $stateParams, $mmUtil, $mmCoursePrefetchDelegate, $mmCourseHelper, $mmaModImscp, $log, mmaModImscpComponent,
    $ionicPopover, $timeout, $q, $mmCourse, $mmApp, $mmText, $translate, $mmaModImscpPrefetchHandler) {
    $log = $log.getInstance('mmaModImscpIndexCtrl');

    var module = $stateParams.module || {},
        courseId = $stateParams.courseid,
        currentItem;

    $scope.title = module.name;
    $scope.description = module.description;
    $scope.component = mmaModImscpComponent;
    $scope.componentId = module.id;
    $scope.externalUrl = module.url;
    $scope.loaded = false;
    $scope.refreshIcon = 'spinner';

    // Initialize empty previous/next to prevent showing arrows for an instant before they're hidden.
    $scope.previousItem = '';
    $scope.nextItem = '';

    function loadItem(itemId) {
        currentItem = itemId;
        $scope.previousItem = $mmaModImscp.getPreviousItem($scope.items, itemId);
        $scope.nextItem = $mmaModImscp.getNextItem($scope.items, itemId);
        var src = $mmaModImscp.getFileSrc(module, itemId);
        if ($scope.src && src.toString() == $scope.src.toString()) {
            // Re-loading same page. Set it to empty and then re-set the src in the next digest so it detects it has changed.
            $scope.src = '';
            $timeout(function() {
                $scope.src = src;
            });
        } else {
            $scope.src = src;
        }
    }

    function fetchContent() {
        // Load module contents if needed.
        return $mmCourse.loadModuleContents(module, courseId).then(function() {
            $scope.items = $mmaModImscp.createItemList(module.contents);
            fillContextMenu(module, courseId);
            if ($scope.items.length && typeof currentItem == 'undefined') {
                currentItem = $scope.items[0].href;
            }

            if (module.contents && module.contents.length) {
                var downloadFailed = false;

                // Try to get the imscp data.
                return $mmaModImscp.getImscp(courseId, module.id).then(function(imscp) {
                    $scope.title = imscp.name || $scope.title;
                    $scope.description = imscp.intro ||  $scope.description;
                }).catch(function() {
                    // Ignore errors since this WS isn't available in some Moodle versions.
                }).then(function() {
                    // Download content.
                    return $mmaModImscpPrefetchHandler.download(module);
                }).catch(function() {
                    // Mark download as failed but go on since the main files could have been downloaded.
                    downloadFailed = true;
                }).then(function() {
                    return $mmaModImscp.getIframeSrc(module).then(function() {
                        loadItem(currentItem);

                        if (downloadFailed && $mmApp.isOnline()) {
                            // We could load the main file but the download failed. Show error message.
                            $mmUtil.showErrorModal('mm.core.errordownloadingsomefiles', true);
                        }
                    }).catch(function() {
                        $mmUtil.showErrorModal('mma.mod_imscp.deploymenterror', true);
                        return $q.reject();
                    }).finally(function() {
                        $scope.loaded = true;
                        $scope.refreshIcon = 'ion-refresh';
                    });
                });
            }
            return $q.reject();
        }).catch(function() {
            $mmUtil.showErrorModal('mma.mod_imscp.deploymenterror', true);
            return $q.reject();
        });
    }

    $scope.doRefresh = function() {
        if ($scope.loaded) {
            $scope.refreshIcon = 'spinner';
            return $mmaModImscp.invalidateContent(module.id, courseId).finally(function() {
                return fetchContent();
            }).finally(function() {
                $scope.$broadcast('scroll.refreshComplete');
            });
        }
    };

    $scope.loadItem = function(itemId) {
        if (!itemId) {
            // Not valid, probably a category.
            return;
        }

        $scope.popover.hide();
        loadItem(itemId);
    };

    $scope.getNumberForPadding = function(n) {
        return new Array(n);
    };

    // Convenience function that fills Context Menu Popover.
    function fillContextMenu(module, courseId, invalidateCache) {
        $mmCourseHelper.getModulePrefetchInfo(module, courseId, invalidateCache).then(function(moduleInfo) {
            console.log(moduleInfo); //to check the prefetch module info in console
            $scope.size = moduleInfo.size > 0 ? moduleInfo.sizeReadable : 0;
            $scope.prefetchStatusIcon = moduleInfo.statusIcon;
            $scope.timemodified = moduleInfo.timemodified > 0 ? $translate.instant('mm.core.lastmodified') + ': ' + moduleInfo.timemodifiedReadable : "";
        });
    }

    $scope.removeFiles = function() {
        $mmUtil.showConfirm($translate('mm.course.confirmdeletemodulefiles')).then(function() {
            $mmCoursePrefetchDelegate.removeModuleFiles(module, courseId);
        });
    };

    // Context Menu Prefetch action.
    $scope.prefetch = function() {
        var icon = $scope.prefetchStatusIcon;

        $scope.prefetchStatusIcon = 'spinner'; // Show spinner since this operation might take a while.

        // We need to call getDownloadSize, the package might have been updated.
        $mmCoursePrefetchDelegate.getModuleDownloadSize(module, courseId).then(function(size) {
            $mmUtil.confirmDownloadSize(size).then(function() {
                $mmCoursePrefetchDelegate.prefetchModule(module, courseId).catch(function() {
                    if (!$scope.$$destroyed) {
                        $mmUtil.showErrorModal('mm.core.errordownloading', true);
                    }
                });
            }).catch(function() {
                // User hasn't confirmed, stop spinner.
                $scope.prefetchStatusIcon = icon;
            });
        }).catch(function(error) {
            $scope.prefetchStatusIcon = icon;
            if (error) {
                $mmUtil.showErrorModal(error);
            } else {
                $mmUtil.showErrorModal('mm.core.errordownloading', true);
            }
        });
    };

    // Context Menu Description action.
    $scope.expandDescription = function() {
        $mmText.expandText($translate.instant('mm.core.description'), $scope.description, false, mmaModImscpComponent, module.id);
    };

    $timeout(function() {
        $ionicPopover.fromTemplateUrl('addons/mod/imscp/templates/toc.html', {
            scope: $scope
        }).then(function(popover) {
            $scope.popover = popover;
        });
    });

    fetchContent().then(function() {
        $mmaModImscp.logView(module.instance).then(function() {
            $mmCourse.checkModuleCompletion(courseId, module.completionstatus);
        });
    });
});
