import * as idb from "idb"
import * as qlog from "./qlog-schema"

interface VideoQlogOverviewDB extends idb.DBSchema {
    overview: {
        value: string
        key: string
    }
}

interface VideoQlogDB extends idb.DBSchema {
    events: {
        key: string,
        value: IVideoEvent
        // value: string
    };
}

export interface IVideoEvent {
    time: number,
    category: string,
    type: qlog.EventType,
    data: qlog.EventData
}

// Represents a single video trace
export class VideoQlog {
    private traceName!: string;
    private logDatabase!: idb.IDBPDatabase<VideoQlogDB>;
    private overviewDatabase!: VideoQlogOverviewManager;
    private startTimestamp!: number;
    private startTimer!: number;

    async init(traceName: string | undefined) {
        if (!window.indexedDB) {
            console.error("No support for IndexedDB, halting videoQlog.");
            return;
        }

        this.startTimestamp = new Date().getTime();
        this.startTimer = window.performance.now();
        this.traceName = traceName || this.startTimestamp.toString();

        let databaseName: string = "videoQlog-" + this.traceName;
        this.logDatabase = await idb.openDB<VideoQlogDB>(databaseName, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains("events")) {
                    db.createObjectStore("events", { autoIncrement: true })
                }
            }
        });

        this.overviewDatabase = new VideoQlogOverviewManager();
        await this.overviewDatabase.init();
        await this.overviewDatabase.registerNewDatabase(databaseName);
    }

    public getCurrentTimeOffset(): number {
        return window.performance.now() - this.startTimer;
    }

    public async generateBlob(): Promise<string> {
        let rv = await this.retrieveLogs().then(logs => {
            let time: Date = new Date(new Date().getTime());
            // https://quiclog.github.io/internet-drafts/draft02/draft-marx-qlog-main-schema.html
            let qlogJson: any = {
                qlog_version: "draft-02",
                qlog_format: "JSON",
                title: "qlog-abr",
                description: "",
                traces: [
                    {
                        title: "MPEG-DASH dash.js",
                        description: `MPEG-DASH dash.js collection [${time.toISOString()}] [${navigator.userAgent}]`,
                        vantage_point: {
                            name: "DashJS application layer",
                            type: qlog.VantagePointType.client
                        },
                        common_fields: {
                            protocol_type: "QLOG_ABR", // TODO jherbots
                            reference_time: "" + this.startTimestamp,
                            time_format: "relative",
                        },
                        events: logs
                    }
                ]
            };

            return JSON.stringify(qlogJson);
        });
        return rv;
    }

    private async retrieveLogs(): Promise<any[]> {
        let logs: any[] = await this.logDatabase.getAll("events");
        return logs;
    }

    private wrapEventData(category: string, type: qlog.EventType, data: qlog.EventData): IVideoEvent {
        return {
            time: this.getCurrentTimeOffset(),
            category: category,
            type: type,
            data: data
        };
    }

    private async registerEvent(eventData: IVideoEvent) {
        await this.logDatabase.put("events", eventData);
    }

    // ***
    // Video QLog formatters
    // ***

    // Native events

    public async onError(code: number, error: string) {
        let eventData: qlog.IEventApplicationError = {
            code: code,
            description: error,
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.error, qlog.GenericEventType.application_error, eventData));
    }

    public async onPlaybackEnded(timestamp: number) {
        let eventData: qlog.IEventPlaybackStreamEnd = {
            playhead: {
                ms: timestamp
            }
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.stream_end, eventData));
    }

    public async onPlayheadProgress(timestamp: number, timeToEnd?: number) {
        let eventData: qlog.IEventPlaybackPlayheadProgress = {
            playhead: {
                ms: timestamp
            }
        };
        if (timeToEnd !== undefined) {
            eventData.remaining = { ms: timeToEnd };
        }
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.playhead_progress, eventData));
    }

    public async onStreamInitialised(autoplay: boolean) {
        let eventData: qlog.IEventPlaybackStreamInitialised = {
            autoplay: autoplay,
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.stream_initialised, eventData));
    }

    public async onMetadataLoaded(protocol: qlog.Protocol, stream_type: qlog.StreamType, url: string, manifest_path: string, duration: number) {
        let eventData: qlog.IEventPlaybackMetadataLoaded = {
            protocol: protocol,
            stream_type: stream_type,
            url: url,
            manifest: manifest_path,
            media_duration: duration,
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.metadata_loaded, eventData));
    }

    public async onStreamEnded(timestamp: number) {
        let eventData: qlog.IEventPlaybackStreamEnd = {
            playhead: {
                ms: timestamp
            }
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.stream_end, eventData));
    }

    // public async onRepresentationSwitch(mediaType: qlog.MediaType, newRepName: string, bitrate: number) {
    //     let eventData: qlog.IEventABRRepresentationSwitch = {
    //         media_type: mediaType,
    //         to: {
    //             id: newRepName,
    //             bitrate: bitrate,
    //         }
    //     };
    //     await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.ABREventType.representation_switch, eventData));
    // }

    public async onRepresentationSwitch(mediaType: qlog.MediaType, to: string, from?: string) {
        let eventData: qlog.IEventABRRepresentationSwitch = {
            media_type: mediaType,
            to: {
                id: to,
            }
        };
        if (from !== undefined) {
            eventData.from = {id: from};
        }
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.ABREventType.representation_switch, eventData));
    }

    public async onQualityChange(mediaType: qlog.MediaType, to: string, from?: string) {
        let eventData: qlog.IEventPlaybackQualityChanged = {
            media_type: mediaType,
            to: {
                id: to,
            }
        };
        if (from !== undefined) {
            eventData.from = {id: from};
        }
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.playback, qlog.PlaybackEventType.quality_changed, eventData));
    }

    public async onReadystateChange(state: qlog.ReadyState) {
        let eventData: qlog.IEventABRReadystateChange = {
            state: state
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.ABREventType.readystate_change, eventData));
    }

    public async onBufferLevelUpdate(mediaType: qlog.MediaType, level: number) {
        let eventData: qlog.IEventBufferOccupancyUpdate = {
            media_type: mediaType,
            buffer: {
                level_ms: level
            }
        };
        await this.registerEvent(this.wrapEventData("video", qlog.BufferEventType.occupancy_update, eventData));
    }

    public async onRebuffer(playhead: number) {
        let eventData: qlog.IEventPlaybackStall = {
            playhead: {
                ms: playhead
            }
        };
        await this.registerEvent(this.wrapEventData("video", qlog.PlaybackEventType.stall, eventData));
    }

    public async onPlayerInteraction(action: qlog.InteractionState, playhead_ms: number, playback_rate?: number, volume?: number) {
        let eventData: qlog.IEventPlaybackPlayerInteraction = {
            state: action,
            playhead: {
                ms: playhead_ms
            },
        };
        if (playback_rate !== undefined) {
            eventData.playback_rate = playback_rate;
        }
        if (volume !== undefined) {
            eventData.volume = volume;
        }
        await this.registerEvent(this.wrapEventData("video", qlog.PlaybackEventType.player_interaction, eventData));
    }

    public inferMediaTypeFromURL(url: string): qlog.MediaType {
        const extension = url.split('.').slice(-1)[0];

        //TODO NOTE might not include all known extensions
        const video_extensions: string[] = [
            'avi',
            'mkv',
            'mp4', 'm4p', 'm4v',
            'webm',
        ];
        if (video_extensions.includes(extension)) {
            return qlog.MediaType.video;
        }

        //TODO NOTE might not include all known extensions
        const audio_extensions: string[] = [
            'aac',
            'm4a',
            'mp3',
            'wav'
        ];
        if (audio_extensions.includes(extension)) {
            return qlog.MediaType.audio;
        }

        //TODO NOTE might not include all known extensions
        const subtitles_extensions: string[] = [
            'srt'
        ];
        if (subtitles_extensions.includes(extension)) {
            return qlog.MediaType.subtitles;
        }

        return qlog.MediaType.other;
    }

    public async onRequest(url: string, media_type: qlog.MediaType) {
        let eventData: qlog.IEventNetworkRequest = {
            resource_url: url,
            media_type: media_type,
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.NetworkEventType.request, eventData));
    }

    public async onRequestUpdate(url: string, bytes_received: number, rtt?: number) {
        let eventData: qlog.IEventNetworkRequestUpdate = {
            resource_url: url,
            bytes_received: bytes_received,
        };
        if (rtt !== undefined) {
            eventData.rtt = rtt;
        }
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.NetworkEventType.request_update, eventData));
    }

    public async onRequestAbort(url: string) {
        let eventData: qlog.IEventNetworkRequestAbort = {
            resource_url: url,
        };
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.NetworkEventType.request_abort, eventData));
    }

    public async UpdateMetrics(metrics: qlog.IEventABRStreamMetrics) {
        let eventData: qlog.IEventABRStreamMetrics = metrics;
        await this.registerEvent(this.wrapEventData(qlog.EventCategory.abr, qlog.ABREventType.metrics_updated, eventData));
    }
}

export class VideoQlogOverviewManager {
    private overviewDatabase!: idb.IDBPDatabase<VideoQlogOverviewDB>;

    public async init() {
        this.overviewDatabase = await idb.openDB<VideoQlogOverviewDB>("VideoQlog-overview", 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains("overview")) {
                    db.createObjectStore("overview", { autoIncrement: true })
                }
            }
        });
    }

    public async clearAll() {
        let databaseNames: string[] = await this.overviewDatabase.getAll("overview");
        databaseNames.forEach(database => {
            idb.deleteDB(database);
        });
        await this.overviewDatabase.clear("overview");
    }

    public async registerNewDatabase(databaseName: string) {
        return this.overviewDatabase.put("overview", databaseName);
    }
}
