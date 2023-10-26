import dashjs from "dashjs";
import * as VideoQlog from "./videoQlog"
import * as qlog from "./qlog-schema"

class LoggingHelpers {
    public lastRepresentation: string;
    public lastDecodedByteCount: number;
    public lastBitRate: number;

    constructor() {
        this.lastRepresentation = "";
        this.lastDecodedByteCount = 0;
        this.lastBitRate = -1;
    }
}

export class dashjs_qlog_player {
    private active: boolean;
    private video: HTMLVideoElement;
    private url: string;
    private manifest: any;
    private autosave: boolean;
    private player: dashjs.MediaPlayerClass;
    private eventPoller: NodeJS.Timeout | undefined;
    private eventPollerChrome: NodeJS.Timeout | undefined;
    private videoQlog: VideoQlog.VideoQlog;
    private statusBox: HTMLElement;
    private statusItems: { [key: string]: HTMLElement };
    private loggingHelpers: LoggingHelpers;
    private simulatedInteractions: Array<VideoQlog.IVideoEvent>;
    private simulatedInteractionsIndex: number;

    public autoplay: boolean;

    static readonly eventPollerInterval = 100;//ms
    static readonly bitratePollerInterval = 5000;//ms
    static readonly bitratePollerIntervalSeconds = dashjs_qlog_player.bitratePollerInterval / 1000;//s

    constructor(video_element: HTMLVideoElement, url: string, autosave: boolean, statusBox: HTMLElement) {
        // create important video streaming elements
        this.active = false;
        this.video = video_element;
        this.url = url;
        this.manifest = undefined;
        this.autoplay = false;
        this.autosave = autosave;
        this.player = dashjs.MediaPlayer().create();
        this.videoQlog = new VideoQlog.VideoQlog();
        this.eventPoller = undefined;
        this.eventPollerChrome = undefined;
        this.statusBox = statusBox;
        this.statusItems = {};
        this.setStatus('status', 'uninitialised', 'black');
        this.loggingHelpers = new LoggingHelpers();
        this.simulatedInteractions = new Array<VideoQlog.IVideoEvent>();
        this.simulatedInteractionsIndex = 0;
    }

    public async setup() {
        this.active = true;
        this.setStatus('status', 'initialising', 'orange');

        await this.videoQlog.init(undefined);   //TODO generate trace name?

        this.player.updateSettings({
            'debug': {
                /* Can be LOG_LEVEL_NONE, LOG_LEVEL_FATAL, LOG_LEVEL_ERROR, LOG_LEVEL_WARNING, LOG_LEVEL_INFO or LOG_LEVEL_DEBUG */
                //'logLevel': dashjs.LogLevel.LOG_LEVEL_DEBUG
            }
        });

        const mediaPlayerEvents = dashjs.MediaPlayer.events;
        for (const eventKey in mediaPlayerEvents) {
            //@ts-expect-error
            const eventValue = mediaPlayerEvents[eventKey];

            if (eventValue == mediaPlayerEvents.BUFFER_LEVEL_UPDATED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onBufferLevelUpdate(data['mediaType'], data['bufferLevel'] * 1000);
                });
            }

            else if (eventValue == mediaPlayerEvents.BUFFER_EMPTY) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRebuffer(this.video.currentTime * 1000);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_TIME_UPDATED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlayheadProgress(data['time'] * 1000, data['timeToEnd'] * 1000);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_PROGRESS) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlayheadProgress(this.video.currentTime * 1000, undefined);
                });
            }

            else if (eventValue == mediaPlayerEvents.FRAGMENT_LOADING_STARTED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRequest(data['request']['url'], data['mediaType']);
                });
            }

            else if (eventValue == mediaPlayerEvents.FRAGMENT_LOADING_COMPLETED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRequestUpdate(data['request']['url'], data['request']['bytesLoaded'], data['request']['requestEndDate'] - data['request']['requestStartDate']);
                });
            }

            else if (eventValue == mediaPlayerEvents.FRAGMENT_LOADING_ABANDONED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRequestAbort(data['request']['url']);
                });
            }

            else if (eventValue == mediaPlayerEvents.MANIFEST_LOADED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRequestUpdate(this.url, 0);
                    //TODO size and rtt
                    this.videoQlog.onMetadataLoaded(data['data']['protocol'], data['data']['type'], this.url, "manifest.json", data['data']['mediaPresentationDuration'] * 1000);
                });
            }

            else if (eventValue == mediaPlayerEvents.QUALITY_CHANGE_REQUESTED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    if (data['oldQuality']) {
                        this.videoQlog.onRepresentationSwitch(data['mediaType'], data['newQuality'], data['bitrateInfo']['bitrate'], data['oldQuality']);
                    } else {
                        this.videoQlog.onRepresentationSwitch(data['mediaType'], data['newQuality'], data['bitrateInfo']['bitrate']);
                    }
                });
            }

            else if (eventValue == mediaPlayerEvents.REPRESENTATION_SWITCH) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onRepresentationSwitch(data['mediaType'], data['currentRepresentation']['id'], data['currentRepresentation']['bandwidth']);
                });
            }

            else if (eventValue == mediaPlayerEvents.QUALITY_CHANGE_RENDERED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    if (data['oldQuality']) {
                        this.videoQlog.onQualityChange(data['mediaType'], data['newQuality'], data['oldQuality']);
                    } else {
                        this.videoQlog.onQualityChange(data['mediaType'], data['newQuality']);
                    }
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_VOLUME_CHANGED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlayerInteraction(qlog.InteractionState.volume, this.video.currentTime * 1000, undefined, this.video.volume);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_RATE_CHANGED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlayerInteraction(qlog.InteractionState.playback_rate, this.video.currentTime * 1000, this.video.playbackRate, undefined);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_SEEKING) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlayerInteraction(qlog.InteractionState.seek, data['seekTime'] * 1000);
                });
            }

            else if ([
                mediaPlayerEvents.PLAYBACK_STARTED,
                mediaPlayerEvents.PLAYBACK_PAUSED,
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    //TODO player state
                    //this.videoQlog.onReadystateChange(this.video.readyState);
                });
            }

            else if ([
                mediaPlayerEvents.CAN_PLAY,
                mediaPlayerEvents.CAN_PLAY_THROUGH,
                mediaPlayerEvents.PLAYBACK_PLAYING,
                mediaPlayerEvents.PLAYBACK_WAITING,
                mediaPlayerEvents.PLAYBACK_LOADED_DATA,
                mediaPlayerEvents.PLAYBACK_METADATA_LOADED,
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onReadystateChange(this.video.readyState);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_NOT_ALLOWED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onError(-1, data['type']);
                });
            }

            else if (eventValue == mediaPlayerEvents.STREAM_INITIALIZED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    const streamInfo = data['streamInfo'];
                    this.videoQlog.onStreamInitialised(this.autoplay);
                });
            }

            else if (eventValue == mediaPlayerEvents.PLAYBACK_ENDED) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    this.videoQlog.onPlaybackEnded(this.video.currentTime * 1000);
                    this.stopLogging();
                    if (this.autosave) {
                        this.downloadCurrentLog();
                    }
                });
            }

            else if ([
                mediaPlayerEvents.METRIC_ADDED,
                mediaPlayerEvents.METRIC_UPDATED,
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    const data = hookArguments[0];
                    const metric = data['metric'];
                    const metricData = data['value'];

                    if (['BufferLevel', 'HttpList', 'BufferState', 'SchedulingInfo', 'RequestsQueue', 'PlayList', 'RepSwitchList', 'DVRInfo', 'ManifestUpdate', 'ManifestUpdatePeriodInfo', 'ManifestUpdateRepresentationInfo'].includes(metric)) {
                        //ignore, no useful or redundant data
                    }
                    else if (metric == 'DroppedFrames') {
                        this.videoQlog.UpdateMetrics({ dropped_frames: metricData['droppedFrames'] });
                    }
                    else {
                        console.warn('metric added/updated', metric, data);
                    }
                });
            }

            else if ([    // ignored events
                mediaPlayerEvents.AST_IN_FUTURE,      // not useful
                mediaPlayerEvents.METRICS_CHANGED,      // no data
                mediaPlayerEvents.METRIC_CHANGED,       // only mediaType
                mediaPlayerEvents.PLAYBACK_SEEKED,      // no data
                mediaPlayerEvents.BUFFER_LOADED,        // no data
                mediaPlayerEvents.BUFFER_LEVEL_STATE_CHANGED,// no data
                mediaPlayerEvents.CAPTION_CONTAINER_RESIZE,
                mediaPlayerEvents.CAPTION_RENDERED,
            ].includes(eventValue)) {
                // no hook placed
                // console.log('ignored', eventValue)
            }

            else { // default dummy hook
                this.player.on(eventValue, (...hookArguments: any) => {
                    if (!this.active) { return; }
                    let dummy_string = "dummy hook"
                    for (let index = 0; index < hookArguments.length; index++) {
                        const argument = hookArguments[index];
                        dummy_string += `\t${argument.type}`
                        if (argument.message) {
                            dummy_string += `{${argument.message}}`
                        }
                    }
                    console.warn(dummy_string, hookArguments);
                });
                console.log('dummied event:', eventKey);
            }
        }

        // user interaction with player
        // https://html.spec.whatwg.org/multipage/media.html#mediaevents
        this.video.addEventListener('play', () => {
            if (!this.active) { return; }
            this.videoQlog.onPlayerInteraction(qlog.InteractionState.play, this.video.currentTime * 1000);
        });
        this.video.addEventListener('pause', () => {
            if (!this.active) { return; }
            this.videoQlog.onPlayerInteraction(qlog.InteractionState.pause, this.video.currentTime * 1000);
        });
        this.video.addEventListener('resize', () => {
            if (!this.active) { return; }
            this.videoQlog.onPlayerInteraction(qlog.InteractionState.resize, this.video.currentTime * 1000);
        });
        this.video.addEventListener('error', (e) => {
            if (!this.active) { return; }
            this.videoQlog.onError(-1, e.message);
        });

        this.player.initialize();
        await this.videoQlog.onReadystateChange(this.video.readyState);

        await new Promise((resolve, reject) => {
            this.videoQlog.onRequest(this.url, qlog.MediaType.other);
            this.player.retrieveManifest(this.url, async (manifest, error) => {

                if (error) {
                    this.videoQlog.onError(-1, error);
                    reject(error);
                }

                if (manifest === null) {
                    this.videoQlog.onError(-1, 'no metadata');
                    reject("null manifest")
                    return;
                }

                this.player.attachView(this.video);
                this.player.attachSource(manifest);
                this.player.setAutoPlay(this.autoplay);

                this.manifest = manifest;
                if (this.autosave) {
                    this.generateAutomaticDownloadEvent("manifest.json", JSON.stringify(manifest));
                }

                resolve(undefined);
            });
        });

        this.startLogging();
        this.setStatus('status', 'initialised', 'green');
    }

    private async eventPollerFunction() {
        let activeStream = this.player.getActiveStream();
        if (!activeStream) { return; }
        let streamInfo = activeStream.getStreamInfo();
        let dashMetrics = this.player.getDashMetrics();
        let dashAdapter = this.player.getDashAdapter();

        if (dashMetrics && streamInfo) {
            const periodIdx = streamInfo.index;
            let repSwitch = dashMetrics.getCurrentRepresentationSwitch('video');
            let adaptation = dashAdapter.getAdaptationForType(periodIdx, 'video', streamInfo);
            //@ts-expect-error
            let adaptationInfo = repSwitch ? adaptation.Representation_asArray.find(function (rep: any) {
                //@ts-expect-error
                return rep.id === repSwitch.to;
            }) : undefined;

            let bufferLevelVideo = dashMetrics.getCurrentBufferLevel('video');
            let bufferLevelAudio = dashMetrics.getCurrentBufferLevel('audio');
            //@ts-expect-error
            let bitrate = repSwitch ? Math.round(dashAdapter.getBandwidthForRepresentation(repSwitch.to, periodIdx) / 1000) : NaN;
            let frameRate = adaptationInfo ? adaptationInfo.frameRate : 0;

            this.setStatus('buffer level (video)', bufferLevelVideo + " s", 'black');
            this.setStatus('buffer level (audio)', bufferLevelAudio + " s", 'black');
            this.setStatus('framerate', frameRate + " fps", 'black');
            this.setStatus('bitrate', bitrate + " Kbps", 'black');

            if (this.loggingHelpers.lastBitRate !== bitrate) {
                await this.videoQlog.UpdateMetrics({ bitrate: bitrate });
                this.loggingHelpers.lastBitRate = bitrate;
            }

            if (adaptationInfo && this.loggingHelpers.lastRepresentation !== adaptationInfo.id) {
                await this.videoQlog.onRepresentationSwitch(qlog.MediaType.video, adaptationInfo.id, adaptationInfo.bandwidth);
                this.loggingHelpers.lastRepresentation = adaptationInfo.id;
            }
        }
    }

    private async eventPollerFunctionChrome() {
        //@ts-expect-error
        let calculatedBitrate = (((this.video.webkitVideoDecodedByteCount - this.loggingHelpers.lastDecodedByteCount) / 1000) * 8) / dashjs_qlog_player.bitratePollerIntervalSeconds;
        this.setStatus('bitrate (webkit)', Math.round(calculatedBitrate) + " Kbps", 'black')
        //@ts-expect-error
        this.loggingHelpers.lastDecodedByteCount = this.video.webkitVideoDecodedByteCount;
    }

    public async startLogging() {
        this.active = true;
        this.eventPoller = setInterval(() => { this.eventPollerFunction() }, dashjs_qlog_player.eventPollerInterval);
        //@ts-expect-error
        if (this.video.webkitVideoDecodedByteCount !== undefined) {
            this.eventPollerFunctionChrome(); // first log point is now
            this.eventPollerChrome = setInterval(() => { this.eventPollerFunctionChrome() }, dashjs_qlog_player.bitratePollerInterval);
        }
    }

    public async stopLogging() {
        this.active = false;
        clearInterval(this.eventPoller);
        clearInterval(this.eventPollerChrome);
    }

    public setSimulatedInteractions(interactions: Array<VideoQlog.IVideoEvent>) {
        this.simulatedInteractions = interactions;
        // console.log(this.simulatedInteractions);

        setTimeout(() => {
            // execute
            const interaction = this.simulatedInteractions[this.simulatedInteractionsIndex];
            this.simulateInteraction(interaction);
            
            // queue
            this.queueNextInteractionSimulation();
        }, this.simulatedInteractions[this.simulatedInteractionsIndex].time - this.videoQlog.getCurrentTimeOffset());
    }

    private async simulateInteraction(interaction: any) {
        let itype = interaction['data']['state'];
        switch (itype) {
            case 'play':
                this.player.play();
                break;

            case 'pause':
                this.player.pause();
                break;

            case 'volume':
                this.player.setVolume(interaction['data']['volume']);
                break;

            case 'playback_rate':
                this.player.setPlaybackRate(interaction['data']['playback_rate']);
                break;

            case 'seek':
                this.player.seek(interaction['data']['playhead']['ms']/1000);
                break;
        
            default:
                console.warn('unable to simulate interaction of type', itype, interaction)
                break;
        }
    }

    private async queueNextInteractionSimulation() {
        this.simulatedInteractionsIndex++;
        if (this.simulatedInteractionsIndex < this.simulatedInteractions.length) {
            setTimeout(() => {
                // execute
                const interaction = this.simulatedInteractions[this.simulatedInteractionsIndex];
                this.simulateInteraction(interaction);
                
                // queue
                this.queueNextInteractionSimulation();
            }, this.simulatedInteractions[this.simulatedInteractionsIndex].time - this.videoQlog.getCurrentTimeOffset());
        }
    }

    public async downloadCurrentLog() {
        let data = await this.videoQlog.generateBlob();
        this.generateAutomaticDownloadEvent("dashjs.qlog", data);
    }

    public async downloadManifest() {
        if (this.manifest) {
            this.generateAutomaticDownloadEvent("manifest.json", JSON.stringify(this.manifest));
        } else {
            console.error("manifest not available");
        }
    }

    public wipeDatabases() {
        let dbManager = new VideoQlog.VideoQlogOverviewManager();
        dbManager.init().then(() => {
            dbManager.clearAll().then(() => console.info("All databases wiped."));
        });
    }

    public setStatus(key: string, value: string, color: string) {
        if (this.statusItems[key] === undefined) {
            let newStatus = document.createElement('div');
            let keySpan = document.createElement('strong');
            keySpan.innerText = key + ': ';
            let valueSpan = document.createElement('span');

            newStatus.appendChild(keySpan);
            newStatus.appendChild(valueSpan);
            this.statusBox.appendChild(newStatus);

            this.statusItems[key] = valueSpan;
        }

        this.statusItems[key].innerText = value;
        this.statusItems[key].style.color = color;
    }

    private generateAutomaticDownloadEvent(filename: string, data: string) {
        let blob: Blob = new Blob([data], { type: "application/json;charset=utf8" });
        let link: string = window.URL.createObjectURL(blob);
        let domA = document.createElement("a");
        domA.download = filename;
        domA.href = link;
        document.body.appendChild(domA);
        domA.click();
        document.body.removeChild(domA);
    }
}

export default dashjs_qlog_player;