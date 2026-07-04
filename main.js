'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Our custom modules
const { AnthbotCloudApiClient } = require('./lib/anthbotApi');
const { AnthbotDevice } = require('./lib/anthbotDevice');

// TODO: Constants that should maybe be configurable?
const CONNECTION_RETRY_INTERVAL_MS = 30 * 1000; // Starting retry interval
const CONNECTION_RETRY_BACKOFF = 2; // Exponential backoff factor for connection retries
const CONNECTION_RETRY_MAX_INTERVAL_MS = 30 * 60 * 1000; // Maximum retry interval

class Anthbot extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'anthbot',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.devices = [];
        this.client = null;
        this.retryTimer = null;
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL_MS;
    }

    // Set/reset connection
    async setConnected(connected) {
        await this.setState('info.connection', connected, true);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setObjectNotExistsAsync(`info`, {
            type: 'channel',
            common: {
                name: 'Information',
            },
            native: {},
        });

        // Not connected by default
        await this.setConnected(false);

        // Load system.config as lat/lon are required for dawn/dusk calculation
        this.sysConfig = await this.getForeignObjectAsync('system.config');

        // Verify we have credentials
        if (this.config.username == '' || this.config.password == '' || !this.config.regionCode) {
            this.log.error('Incomplete adapter configuration! Please check settings.');
            // Don't actually terminate - when the adapter config is updated that will trigger a restart
        } else {
            this.loginAndStart();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    async onStateChange(id, state) {
        if (state) {
            if (this.checkClient() && state.ack === false) {
                // This is a command from the user (e.g., from the UI or other adapter)
                // and should be processed by the adapter
                this.log.debug(`Command received for ${id}: ${JSON.stringify(state)}`);

                // By default, leave ackState undefined so we won't ack this
                let ackState;

                const idParts = id.split('.');

                const command = idParts.pop();

                // Next level is either 'command' string literal or a custom area ID
                const customAreaId = Number(idParts.pop());

                let serialNumber;
                if (!customAreaId) {
                    // Must be a global command
                    serialNumber = idParts.pop();
                    this.log.debug(`Global command ${command} for ${serialNumber}`);
                } else {
                    // Must be a custom area command
                    idParts.pop(); // Remove 'custom_areas' level
                    idParts.pop(); // Remove 'map' level
                    serialNumber = idParts.pop();
                    this.log.debug(`Custom area command ${command} for ${serialNumber}/${customAreaId}`);
                }

                if (!serialNumber) {
                    this.log.error(`No serial number found in command ${id}`);
                } else {
                    const device = this.devices.find(checkDevice => checkDevice.sn === serialNumber);

                    if (!device) {
                        this.log.error(`Could not find device for command with serial number: ${serialNumber}`);
                    } else {
                        switch (command) {
                            // Global commands

                            case 'mow_start':
                                // To start mowing have to put app_state first.
                                await this.client?.asyncSendServiceCommand(serialNumber, 'app_state', 1);
                            // Purposfully fall through to send the actual command!

                            // Generic one-shot commands
                            /* falls through */
                            case 'charge_start':
                            case 'mow_pause':
                            case 'stop_all_tasks': {
                                await device.doSimpleCommand(command);
                                ackState = true;
                                break;
                            }

                            case 'area_list': {
                                let areaList;
                                // This will affect the next start command only.
                                if (typeof state.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    areaList = this.parseJsonList(state.val);

                                    // Make sure this is a list & is of valid custom or ridable area IDs
                                    if (
                                        !Array.isArray(areaList) ||
                                        !(
                                            areaList.length == 0 ||
                                            (await device.isGoodAreaList('customAreas', areaList)) ||
                                            (await device.isGoodAreaList('ridableAreas', areaList))
                                        )
                                    ) {
                                        // Set to undefined so we don't ack it
                                        this.log.error(`Invalid area list in ${id}`);
                                        areaList = undefined;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    areaList = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(areaList)) {
                                    ackState = JSON.stringify(areaList);
                                }

                                break;
                            }

                            case 'area_set': {
                                const customAreas = this.parseJsonList(state.val);
                                if (!Array.isArray(customAreas)) {
                                    this.log.error(`Invalid area list for command ${id}`);
                                } else {
                                    if (await device.doAreaSet(customAreas)) {
                                        ackState = JSON.stringify(customAreas);
                                    }
                                }

                                break;
                            }

                            // Can be global or for custom area

                            case 'custom_area_mow_start': {
                                // If customAreaId is valid then this is for specific area - pass that to isGoodAreaList
                                // otherwise ommit that and the device's area_list will be used.
                                const goodAreaList = await device.isGoodAreaList(
                                    'customAreas',
                                    customAreaId ? [customAreaId] : undefined,
                                );

                                if (!goodAreaList) {
                                    this.log.error(`Derived invalid area list for command ${id}`);
                                } else {
                                    await device.doCustomAreaMowStart(goodAreaList);
                                    ackState = true;
                                }
                                break;
                            }

                            case 'disable': {
                                await device.disable(state.val);
                                // No need to ack as setting the devices disabled state will do that
                                break;
                            }

                            case 'do_not_disturb': {
                                await device.doDoNotDisturb({ active: state.val ? 1 : 0 });
                                // No need to ack as command will perform sync which will do the ack

                                break;
                            }

                            case 'do_not_disturb_start': {
                                const val = Number(state.val);
                                if (val < 0 || val > 86400) {
                                    this.log.error(`Invalid do not disturb start in ${id}: ${state.val}`);
                                } else if (val > device.timeSetting?.no_disturb?.[0]?.end_time) {
                                    this.log.error(
                                        `Do not disturb start cannot be after end in ${id}: ${val} > ${device.timeSetting?.no_disturb?.[0]?.end_time}`,
                                    );
                                } else {
                                    await device.doDoNotDisturb({ start_time: val });
                                    // No need to ack as command will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'do_not_disturb_end': {
                                const val = Number(state.val);
                                if (val < 0 || val > 86400) {
                                    this.log.error(`Invalid do not disturb end in ${id}: ${state.val}`);
                                } else if (val < device.timeSetting?.no_disturb?.[0]?.start_time) {
                                    this.log.error(
                                        `Do not disturb end cannot be before start in ${id}: ${val} < ${device.timeSetting?.no_disturb?.[0]?.start_time}`,
                                    );
                                } else {
                                    await device.doDoNotDisturb({ end_time: val });
                                    // No need to ack as command will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'ridable_mow_start': {
                                const goodAreaList = await device.isGoodAreaList('ridableAreas');
                                if (goodAreaList) {
                                    await device.doRidableAreaMowStart(goodAreaList);
                                    ackState = true;
                                }
                                break;
                            }

                            // Commands for custom area only

                            case 'cutter_height': {
                                const cutterHeight = Number(state.val);
                                // Must be 30, 40, 50, 60 or 70
                                if (![30, 40, 50, 60, 70].includes(cutterHeight)) {
                                    this.log.error(`Invalid cutter height in ${id}: ${state.val}`);
                                } else {
                                    await device.doCutterHeightSet(customAreaId, cutterHeight);
                                    // No need to ack as doDeviceCommand will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'mow_head': {
                                const mowHead = Number(state.val);
                                if (mowHead < 0 || mowHead > 180) {
                                    this.log.error(`Invalid mow head angle in ${id}: ${state.val}`);
                                } else {
                                    await device.doMowHeadSet(customAreaId, mowHead);
                                    // No need to ack as doDeviceCommand will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'mow_head_alts': {
                                let mowHeadAlts;
                                if (typeof state.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    mowHeadAlts = this.parseJsonList(state.val);

                                    // Make sure this is a list of numbers between 0 & 180
                                    if (
                                        !Array.isArray(mowHeadAlts) ||
                                        !mowHeadAlts.every(
                                            mowHeadAlts => Number(mowHeadAlts) >= 0 && Number(mowHeadAlts) <= 180,
                                        )
                                    ) {
                                        // Set to null so we don't ack it
                                        this.log.error(`Invalid mow head list in ${id}`);
                                        mowHeadAlts = null;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    mowHeadAlts = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(mowHeadAlts)) {
                                    if (mowHeadAlts.length > 0) {
                                        // Make sure current mow_head is in this list, if not - set it ready for next task
                                        const currentMowHead = device.customAreas.find(
                                            area => area.id == customAreaId,
                                        )?.mow_head;
                                        if (!mowHeadAlts.includes(currentMowHead)) {
                                            // Current mow head is not in the new list, so set it to first entry
                                            device.log.info(
                                                `Current mow head ${currentMowHead} is not in alt list, setting to first entry ${mowHeadAlts[0]}`,
                                            );
                                            await device.doAreaSet([{ mow_head: mowHeadAlts[0], id: customAreaId }]);
                                        }
                                    }

                                    // Set in device cache, which will also ack the state
                                    await device.setCustomAreaProperty(customAreaId, { mowHeadAlts });
                                }

                                break;
                            }

                            case 'mow_head_random': {
                                // Force boolean
                                const mowHeadRandom = state.val ? true : false;
                                // Set in device cache, which will also ack the state
                                await device.setCustomAreaProperty(customAreaId, { mowHeadRandom });

                                if (mowHeadRandom) {
                                    // Is now turned on, so randomise mow_head for this custom area
                                    device.log.info(
                                        `Setting random mow head value for newly enabled area ${customAreaId}`,
                                    );
                                    await device.doMowHeadSet(customAreaId);
                                }

                                break;
                            }

                            case 'pobctl_level': {
                                const pobctlLevel = Number(state.val);
                                if (pobctlLevel < 0 || pobctlLevel > 2) {
                                    this.log.error(`Invalid visual inspection level in ${id}: ${state.val}`);
                                } else {
                                    await device.doDeviceCommand('device_config', {
                                        pobctl_level: pobctlLevel,
                                    });
                                    // No need to ack as doDeviceCommand will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'pobctl_switch': {
                                await device.doDeviceCommand('device_config', {
                                    pobctl_switch: state.val ? 1 : 0,
                                });
                                // No need to ack as doDeviceCommand will perform sync which will do the ack

                                break;
                            }

                            case 'rain_continue_time': {
                                const rainContinueTime = Number(state.val);
                                if (rainContinueTime < 0 || rainContinueTime > 24 * 60 * 60) {
                                    this.log.error(`Invalid rain continue time in ${id}: ${state.val}`);
                                } else {
                                    await device.doDeviceCommand('device_config', {
                                        rain_continue_time: rainContinueTime,
                                    });
                                    // No need to ack as doDeviceCommand will perform sync which will do the ack
                                }

                                break;
                            }

                            case 'rain_switch': {
                                await device.doDeviceCommand('device_config', {
                                    rain_switch: state.val ? 1 : 0,
                                });
                                // No need to ack as doDeviceCommand will perform sync which will do the ack

                                break;
                            }

                            case 'schedule_enabled': {
                                // Force boolean
                                const scheduleEnabled = state.val ? true : false;
                                // Set in device cache, which will also ack the state
                                await device.setCustomAreaProperty(customAreaId, { scheduleEnabled });

                                break;
                            }

                            case 'schedule_priority': {
                                const schedulePriority = Number(state.val);

                                // This state must be a number > 0
                                if (schedulePriority > 0) {
                                    // Set in device cache, which will also ack the state
                                    await device.setCustomAreaProperty(customAreaId, { schedulePriority });
                                } else {
                                    this.log.error(`Invalid schedule priority in ${id}: ${state.val}`);
                                }
                                break;
                            }

                            case 'schedule_days_since_last': {
                                const scheduleDaysSinceLast = Number(state.val);

                                // This state must be a number >= 0
                                if (scheduleDaysSinceLast >= 0) {
                                    // Set in device cache, which will also ack the state
                                    await device.setCustomAreaProperty(customAreaId, { scheduleDaysSinceLast });
                                } else {
                                    this.log.error(`Invalid schedule days since last in ${id}: ${state.val}`);
                                }
                                break;
                            }

                            case 'volume': {
                                const volume = Number(state.val);
                                if (volume < 0 || volume > 100) {
                                    this.log.error(`Invalid volume in ${id}: ${state.val}`);
                                } else {
                                    await device.doDeviceCommand('device_config', {
                                        volume,
                                    });
                                    // No need to ack as doDeviceCommand will perform sync which will do the ack
                                }

                                break;
                            }
                            default:
                                device.log.warn(`Unknown command: ${command}`);
                        }
                    }

                    // Ack command if verified valid above
                    if (typeof ackState != 'undefined') {
                        await this.setState(id, ackState, true);
                    }
                }
            }
        } else {
            // The object was deleted or the state value has expired
            this.log.warn(`state ${id} deleted`);
        }
    }

    // Retry connection with backoff
    async retryConnection() {
        if (this.retryTimer) {
            this.log.warn(`Connection retry timer is already running, will wait for that`);
        } else {
            this.client = null;
            this.stopDevices();
            await this.setConnected(false);

            this.log.info(`Setting retry timer for ${this.currentRetryInterval / 1000}s`);
            this.retryTimer = this.setTimeout(() => {
                this.log.debug('Retry timer complete');
                this.retryTimer = null;
                this.loginAndStart();
            }, this.currentRetryInterval);

            // Backoff for next retry...
            this.currentRetryInterval *= CONNECTION_RETRY_BACKOFF;

            // ... but never exceed max retry interval
            if (this.currentRetryInterval > CONNECTION_RETRY_MAX_INTERVAL_MS) {
                this.currentRetryInterval = CONNECTION_RETRY_MAX_INTERVAL_MS;
            }
        }
    }

    // Login & start processing
    async loginAndStart() {
        // Login
        this.client = new AnthbotCloudApiClient({
            verboseLogger: this.log.debug,
            setTimeout: this.setTimeout.bind(this),
        });

        this.log.info('Connecting to Anthbot cloud...');
        try {
            await this.client.asyncLogin(this.config.username, this.config.password, this.config.regionCode);
        } catch (error) {
            this.log.error(`Failed to login to Anthbot cloud: ${error.message}`);
            await this.retryConnection();
            return;
        }

        this.log.debug('Login successful');

        this.log.debug('Searching for bound devices...');
        let boundDevices;
        try {
            boundDevices = await this.client.asyncGetBoundDevices();
        } catch (error) {
            this.log.error(`Failed to fetch bound devices: ${error.message}`);
            await this.retryConnection();
            return;
        }
        this.log.debug(`Found devices: ${JSON.stringify(boundDevices)}`);

        if (boundDevices.length === 0) {
            this.log.error('No bound devices found! Please check your Anthbot cloud account.');
            await this.retryConnection();
            return;
        }

        // Things look pretty good here, so reset the retry interval.
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL_MS;

        for (const boundDevice of boundDevices) {
            const device = new AnthbotDevice({ adapter: this, client: this.client, device: boundDevice });
            await device.start();
            this.devices.push(device);
        }
    }

    /**
     * Check all devices and if at least one is online, set our state to that
     */
    async checkSetOnline() {
        const onlineDevices = this.devices.filter(device => device.isOnline);
        await this.setConnected(onlineDevices.length > 0);
    }

    /**
     * Stop all bound devices
     */
    stopDevices() {
        for (const device of this.devices) {
            device.stop();
        }
    }

    /**
     * @returns {boolean} Does this.client appear to be a valid API client?
     */
    checkClient() {
        if (!this.client || typeof this.client !== 'object') {
            this.log.warn('No API client available!');
            return false;
        }
        return true;
    }

    /**
     * Create multiple read onlystate objects from a list of their parameters
     *
     * @param {string} prefix State ID prefix
     * @param {Array} stateList Array of state parameters
     */

    async createStatesFromList(prefix, stateList, write = false) {
        for (const state of stateList) {
            const common = {
                name: state[0],
                type: state[1],
                role: state[2],
                desc: state[3],
                read: true,
                write,
            };
            if (state[4]) {
                // Add a unit when given
                common.unit = state[4];
            }
            if (state[2].startsWith('button')) {
                // Buttons are not readable
                common.read = false;
            }
            await this.setObjectNotExistsAsync(`${prefix}.${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    /**
     * Parses a JSON string into an array
     *
     * @param {boolean | string | number | null} jsonString String to parse
     * @param {boolean} hardFail Return failure (undefined) on error, otherwise empty list
     * @returns {Array | undefined} Parsed array if valid, otherwise: if hardfail, undefined, otherwise blank list
     */

    parseJsonList(jsonString, hardFail = true) {
        const logLevel = hardFail ? this.log.error : this.log.debug;

        const outOnFail = hardFail ? undefined : [];
        let out = outOnFail;

        if (typeof jsonString !== 'string') {
            logLevel(`JSON to parse is not a string: ${JSON.stringify(jsonString)}`);
        } else {
            try {
                out = JSON.parse(jsonString);
                if (!Array.isArray(out)) {
                    logLevel(`Invalid JSON list, not an array: ${JSON.stringify(jsonString)}`);
                    out = outOnFail;
                }
            } catch (error) {
                logLevel(`Failed to parse JSON list (${JSON.stringify(jsonString)}): ${error.message}`);
            }
        }

        return out;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.unsubscribeStates('*');
            this.stopDevices();
            this.setConnected(false).then(() => {
                callback();
            });
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Anthbot(options);
} else {
    // otherwise start the instance directly
    new Anthbot();
}
