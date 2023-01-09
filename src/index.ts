import dashjs from "dashjs";
import * as VideoQlog from "./videoQlog"
import * as qlog from "./qlog-schema"

class LoggingHelpers {
    public lastRepresentation: string;
    public lastBufferLevelVideo: number;
    public lastBufferLevelAudio: number;
    public lastDecodedByteCount: number;

    constructor() {
        this.lastRepresentation = "";
        this.lastBufferLevelVideo = -1;
        this.lastBufferLevelAudio = -1;
        this.lastDecodedByteCount = 0;
    }
}

export class dashjs_qlog_player {
    private active: boolean;
    private video: HTMLVideoElement;
    private url: string;
    private manifest: any;
    private autosave: boolean;
    private player: dashjs.MediaPlayerClass;
    private eventPoller: NodeJS.Timer | undefined;
    private eventPollerChrome: NodeJS.Timer | undefined;
    private videoQlog: VideoQlog.VideoQlog;
    private statusBox: HTMLElement;
    private statusItems: { [key: string]: HTMLElement };
    private loggingHelpers: LoggingHelpers;

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
    }

    public async setup() {
        this.setStatus('status', 'initialising', 'orange');

        this.player.updateSettings({
            'debug': {
                /* Can be LOG_LEVEL_NONE, LOG_LEVEL_FATAL, LOG_LEVEL_ERROR, LOG_LEVEL_WARNING, LOG_LEVEL_INFO or LOG_LEVEL_DEBUG */
                'logLevel': dashjs.LogLevel.LOG_LEVEL_DEBUG
            }
        });

        /* Extend RequestModifier class and implement our own behaviour */
        this.player.extend("RequestModifier", () => {
            return {
                modifyRequestHeader: (xhr: XMLHttpRequest, urlObject: any) => {
                    if (!this.active) { return xhr; }
                    const url = urlObject.url;
                    this.videoQlog.onRequest(url, this.videoQlog.inferMediaTypeFromURL(url));
                    xhr.addEventListener('loadend', () => {
                        this.videoQlog.onRequestUpdate(url, xhr.response.byteLength);
                    });
                    return xhr;
                },
                modifyRequestURL: (url: string) => {
                    return url; // unmodified
                },
                modifyRequest: (request: any) => {
                    return; // unmodified
                },
            };
        }, false);

        this.player.on(dashjs.MediaPlayer.events["PLAYBACK_ENDED"], () => {
            this.videoQlog.onPlaybackEnded(this.video.currentTime * 1000);
            this.stopLogging();

            if (this.autosave) {
                this.downloadCurrentLog();
            }
        });

        this.player.initialize();
        await this.videoQlog.init(undefined);

        const mediaPlayerEvents = dashjs.MediaPlayer.events;
        for (const eventKey in mediaPlayerEvents) {
            //@ts-expect-error
            const eventValue = mediaPlayerEvents[eventKey];

            if ([ // buffer events
                mediaPlayerEvents.BUFFER_EMPTY,
                mediaPlayerEvents.BUFFER_LOADED,
                mediaPlayerEvents.BUFFER_LEVEL_STATE_CHANGED,
                mediaPlayerEvents.BUFFER_LEVEL_UPDATED
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => { this.mediaplayerHookBufferUpdate(<IArguments>hookArguments) });

            } else if ([ // progress events
                mediaPlayerEvents.PLAYBACK_TIME_UPDATED
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => { this.mediaplayerHookProgress(<IArguments>hookArguments) });

            } else if ([ // error events
                mediaPlayerEvents.PLAYBACK_NOT_ALLOWED
            ].includes(eventValue)) {
                this.player.on(eventValue, (...hookArguments: any) => { this.mediaplayerHookError(<IArguments>hookArguments) });

            } else if ([    // ignored events
                mediaPlayerEvents.METRICS_CHANGED,      // no data
                mediaPlayerEvents.METRIC_CHANGED,       // only mediaType
                mediaPlayerEvents.PLAYBACK_PROGRESS,    // no data
                mediaPlayerEvents.PLAYBACK_PLAYING,     // no data
                mediaPlayerEvents.PLAYBACK_PAUSED,      // no data
                mediaPlayerEvents.PLAYBACK_SEEKED,      // no data
                mediaPlayerEvents.PLAYBACK_SEEKING,     // redundant, caught by playerinteraction
                mediaPlayerEvents.PLAYBACK_LOADED_DATA, // no data
                mediaPlayerEvents.STREAM_INITIALIZED,   // redundant, done manually
                mediaPlayerEvents.PLAYBACK_METADATA_LOADED, // redundant, done manually (stream initialised)
                mediaPlayerEvents.CAN_PLAY,             // no data
                mediaPlayerEvents.CAN_PLAY_THROUGH,     // no data
            ].includes(eventValue)) {
                // no hook placed
                // console.log('ignored', eventValue)

            } else { // default dummy hook
                this.player.on(eventValue, (...hookArguments: any) => { this.mediaplayerHookDummy(<IArguments>hookArguments) });
                console.log('dummied event:', eventKey);
            }
        }

        await new Promise((resolve, reject) => {
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

                await this.videoQlog.onStreamInitialised(this.url, this.autoplay, "manifest.json");
                await this.videoQlog.onReadystateChange(this.video.readyState);

                this.manifest = manifest;
                if (this.autosave) {
                    this.generateAutomaticDownloadEvent("manifest.json", JSON.stringify(manifest));
                }

                // https://html.spec.whatwg.org/multipage/media.html#mediaevents
                this.video.addEventListener('canplay', e => { this.videoQlog.onReadystateChange(this.video.readyState); });
                this.video.addEventListener('play', e => { this.videoQlog.onPlayerInteraction(qlog.InteractionState.play, this.video.currentTime * 1000, this.video.playbackRate, this.video.volume) });
                // this.video.addEventListener('waiting', e => { console.warn("waiting"); console.warn(e); });
                // this.video.addEventListener('playing', e => { console.warn("playing"); console.warn(e); });
                this.video.addEventListener('pause', e => { this.videoQlog.onPlayerInteraction(qlog.InteractionState.pause, this.video.currentTime * 1000, this.video.playbackRate, this.video.volume) });
                this.video.addEventListener('error', e => { this.videoQlog.onError(-1, e.message); });
                this.video.addEventListener('seeking', e => { this.videoQlog.onPlayerInteraction(qlog.InteractionState.seek, this.video.currentTime * 1000, this.video.playbackRate, this.video.volume) });
                // this.video.addEventListener('seeked', e => { console.warn("seeked"); console.warn(e); });
                this.video.addEventListener('timeupdate', e => { this.videoQlog.onPlayheadProgress(this.video.currentTime * 1000); });
                this.video.addEventListener('progress', e => this.videoQlog.onPlayheadProgress(this.video.currentTime * 1000));
                this.video.addEventListener('ratechange', e => { this.videoQlog.onPlayerInteraction(qlog.InteractionState.speed, this.video.currentTime * 1000, this.video.playbackRate, this.video.volume) });
                this.video.addEventListener('loadedmetadata', e => this.videoQlog.onReadystateChange(this.video.readyState));
                this.video.addEventListener('loadeddata', e => this.videoQlog.onReadystateChange(this.video.readyState));
                this.video.addEventListener('canplay', e => this.videoQlog.onReadystateChange(this.video.readyState));
                this.video.addEventListener('canplaythrough', e => this.videoQlog.onReadystateChange(this.video.readyState));
                this.video.addEventListener('stalled', e => this.videoQlog.onRebuffer(this.video.currentTime * 1000));
                // this.video.addEventListener('ended', e => { console.warn("ended"); console.warn(e); });
                // this.video.addEventListener('resize', e => { console.warn("resize"); console.warn(e); });
                this.video.addEventListener('volumechange', e => { this.videoQlog.onPlayerInteraction(qlog.InteractionState.volume, this.video.currentTime * 1000, this.video.playbackRate, this.video.volume) });

                resolve(undefined);
            });
        });

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
            //@ts-expect-error
            let adaptation = dashAdapter.getAdaptationForType(periodIdx, 'video', streamInfo);
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

            if (this.loggingHelpers.lastBufferLevelVideo !== bufferLevelVideo) {
                await this.videoQlog.onBufferLevelUpdate(qlog.MediaType.video, bufferLevelVideo * 1000);
                this.loggingHelpers.lastBufferLevelVideo = bufferLevelVideo;
            }
            if (this.loggingHelpers.lastBufferLevelAudio !== bufferLevelAudio) {
                await this.videoQlog.onBufferLevelUpdate(qlog.MediaType.audio, bufferLevelAudio * 1000);
                this.loggingHelpers.lastBufferLevelAudio = bufferLevelAudio;
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

    private async mediaplayerHookDummy(hookArguments: IArguments) {
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
    }

    private async mediaplayerHookError(hookArguments: IArguments) {
        if (!this.active) { return; }
        const data = hookArguments[0];
        this.videoQlog.onError(-1, data['type']);
    }

    private async mediaplayerHookBufferUpdate(hookArguments: IArguments) {
        if (!this.active) { return; }
        const data = hookArguments[0];
        this.videoQlog.onBufferLevelUpdate(data['mediaType'], data['bufferLevel'] * 1000, data['streamId']);
    }

    private async mediaplayerHookProgress(hookArguments: IArguments) {
        if (!this.active) { return; }
        const data = hookArguments[0];
        this.videoQlog.onPlayheadProgress(data['time'] * 1000, data['timeToEnd'] * 1000, data['streamId']);
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