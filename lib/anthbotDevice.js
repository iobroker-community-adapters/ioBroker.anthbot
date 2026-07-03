// TODO: Constants that should maybe be configurable?

const POLLING_INTERVAL_MS = 60 * 1000; // Poll every 60 seconds
const CLOUD_SYNC_DELAY = 3000; // Time after submitting a command to wait before polling
const SCHEDULE_MS_WAIT_AFTER_DAWN = 3 * 60 * 60 * 1000; // 3 hours after dawn
const SCHEDULE_MS_REQUIRED_FOR_UNKNOWN_CUSTOM_AREA = 4 * 60 * 60 * 1000; // Require at least 4 hours
const MS_IN_DAY = 60 * 60 * 24 * 1000;
const ERRORS_BEFORE_RECONNECT = 10;
const MINIMUM_ELEC_FOR_CUSTOM_AREA_START = 20;

const SunCalc = require('suncalc3');

// Characters forbidden by ioBroker in object IDs, plus whitespace
const FORBIDDEN_ID_CHARS = /[\][*,;'"`<>\\?\s]/g;

/**
 * Sanitize an externally-sourced value for use as (part of) an ioBroker object ID
 *
 * @param {string|number} value Value to sanitize
 * @returns {string} Sanitized value, safe to use in an object ID
 */
function sanitizeId(value) {
    return String(value).replace(FORBIDDEN_ID_CHARS, '_');
}

// TODO: below probably not an exhaustive list of codes
const CUSTOM_AREA_TASK_START_CODE = 1018;
// Codes that signify a task has started...
const TASK_START_CODES = [1015, 1017, CUSTOM_AREA_TASK_START_CODE];
// ... and has finished
const TASK_END_CODES = [1014];
// Codes for charging
const CHARGING_CODES = [1019, 1022];
// Codes for rain:
// - "It's raining, please recharge" code (#1036)
// - "Currently in rain protection mode..." code (#1038)
const RAIN_CODES = [1036, 1038];

// Modes that explicitally imply device is working
const MODES_IMPLY_TASK = [
    'bordermowing',
    'globalmowing',
    'mapping',
    'nestmowing',
    'pointmowing',
    'regionmowing',
    'remotectrl',
    'zonemowing',
];

/**
 * Device specific methods
 */
class AnthbotDevice {
    /**
     *
     * @param {object} options device properties from Anthbot cloud
     */
    constructor(options) {
        this.adapter = options.adapter;
        this.client = options.client;
        this.device = options.device;

        this.shadowState;
        this.customAreas = [];
        this.customAreasRaw = [];
        this.pollingTimeout = null;
        this.pollingStopped = false;
        this.inPoll = false;
        this.isOnline = false;
        this.mapLoaded = false;
        this.isCustomAreaMowing = false;
        // When it's raining, store a timestamp before which we won't start a task
        this.rainRetryTimestamp = 0;

        // Keep count of errors, reconnect on too many
        this.errorCount = 0;

        this.log = {
            error: message => {
                this.adapter.log.error(`${this.device.alias}: ${message}`);
                // Increment error counter
                this.errorCount++;
            },
            warn: message => {
                this.adapter.log.warn(`${this.device.alias}: ${message}`);
            },
            info: message => {
                this.adapter.log.info(`${this.device.alias}: ${message}`);
            },
            debug: message => {
                this.adapter.log.debug(`${this.device.alias}: ${message}`);
            },
        };
    }

    /**
     * Get serial number from device passed in constructor
     */
    get sn() {
        return this.device.sn;
    }

    /**
     * Serial number sanitized for use as (part of) an ioBroker object ID
     */
    get id() {
        return sanitizeId(this.sn);
    }

    /**
     * Do not disturb active from timeSetting
     */
    get doNotDisturbActive() {
        return this.timeSetting?.no_disturb?.[0]?.active == 1;
    }

    /**
     * Do not disturb start time from timeSetting
     */
    get doNotDisturbStart() {
        return this.timeSetting?.no_disturb?.[0]?.start_time;
    }

    /**
     * Do not disturb end time from timeSetting
     */
    get doNotDisturbEnd() {
        return this.timeSetting?.no_disturb?.[0]?.end_time;
    }

    /**
     * Are we paused due to rain?
     *
     * @returns True if rain pause is currently active, false if not
     */
    get isRainPause() {
        return this.rainRetryTimestamp && Date.now() < this.rainRetryTimestamp;
    }

    /**
     * Return true if device is busy, false if available to start a new mowing task
     */
    get isBusy() {
        // Assume nothing in progress
        let isBusy = false;

        // Some modes explicitally imply being busy
        if (MODES_IMPLY_TASK.includes(this.mode)) {
            this.log.debug(`mode is ${this.mode} so must be working`);
            isBusy = true;
        } else if (!Array.isArray(this.codeList)) {
            // If not one of the specific modes above, status cannot simply be derived from mode & we need to use codeList
            this.log.error('codeList is not valid - cannot determine if task is in progress');
        } else {
            const startIndex = this.codeList.findIndex(code => TASK_START_CODES.includes(code.code));
            if (startIndex < 0) {
                // No task start code found - just leave assumption of not busy
            } else {
                const endIndex = this.codeList.findIndex(code => TASK_END_CODES.includes(code.code));
                if (endIndex < 0 || endIndex > startIndex) {
                    // Task start found but no end, or end before start - must be in progress...
                    this.log.debug('Found task start but no end');
                    // ... unless charging & 100% in which case must be free to work
                    isBusy = this.shadowState.elec.value != 100 || this.mode != 'charge';
                } else {
                    // End must be after start - just leave assumption of not busy
                }
            }
        }
        return isBusy;
    }

    /**
     * Get a state ID after prefixing our SN
     *
     * @param {string} stateId State ID to fetch
     */
    async getStateAsync(stateId) {
        return await this.adapter.getStateAsync(`${this.id}.${stateId}`);
    }

    /**
     * Set state on change, but:
     * - Always prefex ID with our SN
     * - Always ack
     *
     * @param {string} stateId ID of state to set, without SN prefix
     * @param {boolean|number|string} val Value
     */
    async setStateChanged(stateId, val) {
        await this.adapter.setStateChanged(`${this.id}.${stateId}`, { val, ack: true });
    }

    /**
     * Start processing for this device
     */
    async start() {
        if ((await this.getStateAsync('command.disable'))?.val) {
            this.log.info(`Device is disabled (${this.device.sn})`);
        } else {
            this.log.info(`Starting (${this.device.sn})`);
            await this.createObjects();
            this.subscribeToDevice();
            // syncDevice also initiates polling
            await this.syncDevice();
        }
    }

    /**
     * Stop processing for this device
     */
    stop() {
        this.log.info(`Stopping (${this.device.sn})`);
        this.clearPolling();
    }

    /**
     * Disable (or enable) this device
     *
     * @param disable Disabled or not?
     */
    disable(disable) {
        this.setStateChanged('command.disable', disable);
        if (disable) {
            this.stop();
        } else {
            this.start();
        }
    }

    /**
     * Create objects for device
     */
    async createObjects() {
        await this.adapter.setObjectNotExistsAsync(this.id, {
            type: 'device',
            common: {
                name: this.device.alias,
            },
            native: {},
        });

        const folders = [
            ['command', 'Commands'],
            ['map', 'Map info'],
            ['map.custom_areas', 'Custom areas, aka. Zones'],
            ['map.ridable_areas', 'Ridable areas, aka. Edges'],
            ['iob_schedule', 'ioBroker schedule'],
            ['status', 'Status'],
        ];

        for (const folder of folders) {
            await this.adapter.setObjectNotExistsAsync(`${this.id}.${folder[0]}`, {
                type: 'folder',
                common: {
                    name: folder[0],
                    desc: folder[1],
                },
                native: {},
            });
        }

        const readOnlyStates = [
            // Shadow properties
            ['status.active_area', 'array', 'list', 'List of areas currently being mowed'],
            ['status.elec', 'number', 'value.battery', 'Battery level', '%'],
            ['status.mode', 'string', 'text', 'Current mode'],
            ['status.mowing_area', 'number', 'value', 'Current mowing area', 'm²'],
            ['status.mowing_time', 'number', 'time.span', 'Current mowing time', 's'],
            ['status.rtk_moved', 'boolean', 'sensor.motion', 'RTK movement detected'],
            ['status.rtk_state', 'boolean', 'sensor', 'RTK state'],

            // Code list (aka. messages)
            // Full list for 'power users'
            ['status.code_list', 'string', 'json', 'JSON object with last page of codes'],
            // Last code for simplcity
            ['status.last_code', 'number', 'value', 'Last code'],
            ['status.last_code_text', 'string', 'text', 'Last code text'],
            ['status.last_code_type', 'string', 'text', 'Last code type (e.g. event, error, etc.)'],

            // Maps
            ['map.area_id', 'string', 'text', 'ID of current map area'],
            ['map.plan_id', 'string', 'text', 'ID of current map plan'],
            ['map.map_area', 'number', 'value', 'Surface area of map', 'm²'],
            ['map.custom_areas.raw', 'string', 'json', 'JSON object with custom area (aka. zone) information'],
            ['map.ridable_areas.raw', 'string', 'json', 'JSON object with ridable area (aka. edge) information'],

            // IoB Schedule
            ['iob_schedule.custom_areas_left_today', 'array', 'list', `List of custom areas left to start today`],
            [
                'iob_schedule.estimated_time_left_todo_today',
                'number',
                'time.span',
                "Estimated elapsed time today's tasks left to do will take",
                's',
            ],
            [
                'iob_schedule.rain_retry_timestamp',
                'number',
                'value.time',
                `Time at which to retry task after rain detection`,
            ],
        ];
        await this.adapter.createStatesFromList(this.id, readOnlyStates);

        const commandStates = [
            // Disable device (do not process with this adapter)
            ['disable', 'boolean', 'switch.enable', 'Do not process this device'],

            // Command buttons
            ['mow_start', 'boolean', 'button.start', 'Start global mowing'],
            ['stop_all_tasks', 'boolean', 'button.stop', 'Stop'],
            ['mow_pause', 'boolean', 'button.pause', 'Pause'],
            ['charge_start', 'boolean', 'button', 'Return home/start charging'],
            ['custom_area_mow_start', 'boolean', 'button.start', 'Start custom area (aka. zone) mowing'],
            ['ridable_mow_start', 'boolean', 'button.start', 'Start ridable area (aka. edge) mowing'],

            // Do not disturb
            ['do_not_disturb', 'boolean', 'switch.enable', 'Do not disturb status'],
            ['do_not_disturb_start', 'number', 'level', 'Seconds since midnight to start', 's'],
            ['do_not_disturb_end', 'number', 'level', 'Seconds since midnight to end', 's'],

            // Area list for relevant commands
            ['area_list', 'array', 'list', `Areas for next command (array of IDs, e.g. '[101,120,132]')`],

            // For 'area_set'
            ['area_set', 'string', 'json', 'JSON object with custom area (aka. zone) information to write'],

            // Visual inspection
            ['pobctl_switch', 'boolean', 'switch.enable', 'Visual inspection switch'],
            ['pobctl_level', 'number', 'level', 'Visual inspection level'],

            // Rain perception
            ['rain_switch', 'boolean', 'switch.enable', 'Rain perception switch'],
            ['rain_continue_time', 'number', 'level', 'Delay after rain before mowing', 's'],

            ['volume', 'number', 'level', 'Volume level', '%'],
        ];
        await this.adapter.createStatesFromList(`${this.id}.command`, commandStates, true);
    }

    /**
     * Subscribe to states to catch foreign changes
     */
    subscribeToDevice() {
        this.log.debug(`Subscribing to states`);
        this.adapter.subscribeStates(`${this.id}.command.*`);
        // TODO: be more selective about custom_areas?
        this.adapter.subscribeStates(`${this.id}.map.custom_areas.*`);
    }

    // This is a bit ugly, but we have chosen to use the Anthbot naming convention
    // which is underscores in state IDs. To mix conventions in state IDs would be
    // even worse for the user so keep lower camelCase in the code and underscores
    // in state IDs.
    //
    // Use camelCase <-> underscore_case conversion between state IDs & properties.

    /**
     * Converts camelCase to underscore_case
     *
     * @param {string} key Name to convert
     * @returns Underscore case version of key
     */
    camelToUnderscoreCase(key) {
        return key.replace(/([A-Z])/g, '_$1').toLowerCase();
    }

    /**
     * Converts underscore_case to camelCase
     *
     * @param {string} key Name to convert
     * @returns camelCase version of key
     */
    underscoreToCamelCase(key) {
        return key.replace(/_([a-z])/g, function f(char) {
            return char[1].toUpperCase();
        });
    }

    /**
     * Set a custom area property in the our customAreas cache while saving to the
     * relevant state. Kindof the reverse of populateDeviceFromStates.
     *
     * @param {number} customAreaId Custom area ID
     * @param {object} propertyObject { key: value } object to set. Like this to get input variable name
     */
    async setCustomAreaProperty(customAreaId, propertyObject) {
        const customArea = this.customAreas.find(checkArea => checkArea.id == customAreaId);
        if (!customArea) {
            this.log.error(`Unknown custom area ID: ${customAreaId}`);
        } else {
            const propertyName = Object.keys(propertyObject)[0];
            const stateId = this.camelToUnderscoreCase(propertyName);
            const val = propertyObject[propertyName];
            await this.setStateChanged(
                `map.custom_areas.${customAreaId}.${stateId}`,
                typeof val == 'object' ? JSON.stringify(val) : val,
            );
            customArea[propertyName] = val;
        }
    }

    /**
     * populateCustomAreasFromStates - Load states for custom areas on a device after new map load.
     * This is mainly so we don't have to repeated load them when checking schedule.
     *
     * @param {Array} customAreasIn - Raw custom area list
     * @returns {Promise<Array>} Copy of custom area list with properties added for each state
     */
    async populateDeviceFromStates(customAreasIn) {
        const customAreasOut = [];
        // TODO: can't get getStatesOfAsync to filter for each customArea so fetch them all & filter ourselves
        const deviceStates = await this.adapter.getStatesOfAsync(this.id);

        for (const customAreaIn of customAreasIn) {
            const customAreaStates = deviceStates.filter(state => {
                const idParts = state._id.split('.');
                idParts.pop(); // Remove ID
                return idParts.pop() == customAreaIn.id;
            });

            const customAreaOut = { ...customAreaIn };
            for (const state of customAreaStates) {
                const stateId = state._id.split('.').pop();
                const propertyName = this.underscoreToCamelCase(stateId);
                if (stateId && propertyName) {
                    // Populate in the passed in device object
                    const stateVal = (await this.adapter.getStateAsync(state._id))?.val;
                    if (state.common.role == 'list') {
                        // We need to parse the stateVal into a list
                        customAreaOut[propertyName] = this.adapter.parseJsonList(stateVal, false);
                    } else {
                        customAreaOut[propertyName] = stateVal;
                    }
                    this.log.debug(`loadded ${propertyName} : ${customAreaOut[propertyName]}`);
                }
            }

            customAreasOut.push(customAreaOut);
        }

        return customAreasOut;
    }

    /**
     * Syncronise device from cloud
     */
    async syncDevice() {
        // Don't sync right now if we are in the middle of polling
        if (this.inPoll) {
            this.syncReq = true;
        } else if (this.adapter.checkClient()) {
            // We're doing a sync, so reset required flag
            this.syncReq = false;

            // Reset polling interval on sync

            await this.pollDevice();
            if (this.pollingTimeout) {
                // This is a legitimate case when a poll issued a command that needed to sync
                this.log.debug('pollingTimeout already set in syncDevice');
                this.clearPolling();
            }
            this.pollingStopped = false;
            this.schedulePolling();
        }
    }

    /**
     * Schedule the next poll cycle via a self-rescheduling setTimeout, avoiding overlap risk
     */
    schedulePolling() {
        if (this.pollingStopped) {
            return;
        }
        this.pollingTimeout = this.adapter.setTimeout(async () => {
            this.pollingTimeout = null;
            if (this.inPoll) {
                // Shouldn't happen unless polling interval is too short
                this.log.warn('pollingTimeout triggered while last poll in progress');
            } else {
                this.log.debug('pollingTimeout triggered');
                await this.pollDevice();
            }
            if (!this.pollingStopped) {
                this.schedulePolling();
            }
        }, POLLING_INTERVAL_MS);
    }

    /**
     * Poll device for updates
     */
    async pollDevice() {
        // Assume success
        let success = true;

        // If we don't encounter new errors, reset this, so remember it's state
        const errorCountStart = this.errorCount;

        if (this.adapter.checkClient()) {
            // Set device flag showing we are already in the middle of a poll so any syncDevice calls are processed after
            this.inPoll = true;

            await this.doDeviceCommand('get_all_props', 1, true);
            // Wait a moment for their backend
            await new Promise(resolve => this.adapter.setTimeout(resolve, CLOUD_SYNC_DELAY, null));

            // Shadow state
            try {
                this.shadowState = await this.client?.asyncGetShadowReportedState(this.sn);
            } catch (error) {
                this.log.error(`Failed to fetch shadow state for device: ${error.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                success = false;
            }

            if (success) {
                // Only do rest of processing if we got a shadow state

                this.log.debug(`Device shadow reported state:\n${JSON.stringify(this.shadowState)}`);
                await this.setShadowState();

                await this.checkCodeList();

                await this.checkMapUpdates();

                await this.checkRainStatus();

                await this.checkCustomAreaTask();

                await this.checkCustomAreaSchedule();
            }

            this.inPoll = false;
        }

        if (success) {
            // Tell adapter to set overall online status
            await this.adapter.checkSetOnline();

            if (this.errorCount == errorCountStart) {
                // No errors this loop, so reset counter
                this.log.debug('No errors this loop, resetting counter');
                this.errorCount = 0;
            }

            // If this poll actually generated a sync request do it now we've finished
            if (this.syncReq) {
                await this.syncDevice();
            }
        } else if (this.errorCount >= ERRORS_BEFORE_RECONNECT) {
            // Something went wrong, reconnect
            this.log.error('Error count exceeded, initiating reconnect');
            await this.adapter.retryConnection();
        }
    }

    /**
     * Stop polling this device
     */
    clearPolling() {
        this.pollingStopped = true;
        if (this.pollingTimeout) {
            this.adapter.clearTimeout(this.pollingTimeout);
            this.pollingTimeout = null;
        }
    }

    /**
     * Send command to Anthbot cloud
     *
     * @param {string} command Command to send
     * @param {number | object} args Arguments to send
     * @param {boolean} noSync Don't sync device after send
     */
    async doDeviceCommand(command, args, noSync = false) {
        this.log.debug(`${command} ${JSON.stringify(args)}`);
        let success = true;
        try {
            await this.client?.asyncSendServiceCommand(this.sn, command, args);
        } catch (error) {
            this.log.error(`Error sending serice command (${command} ${args}): ${error.message}`);
            success = false;
        }

        if (success && !noSync) {
            await this.syncDevice();
        }
    }

    /**
     * Send simple command to Anthbot cloud
     *
     * @param {string} command Command to send
     */
    async doSimpleCommand(command) {
        this.log.info(`${command}`);
        await this.doDeviceCommand(command, 1);
    }

    /**
     * Send do not disturb command to Anthbot cloud
     *
     * @param {object} noDisturbArgs Object with one or more: active, start_time & end_time
     */
    async doDoNotDisturb(noDisturbArgs) {
        const noDisturb = this.timeSetting?.no_disturb;
        if (!Array.isArray(noDisturb) || noDisturb.length != 1) {
            this.log.error(`Current no_disturb looks invalid: ${JSON.stringify(noDisturb)}`);
        } else {
            const args = {
                timezone: this.timeSetting?.timezone,
                timezone_sec: this.timeSetting?.timezone_sec,
            };

            if (typeof noDisturb[0].unlock != 'undefined') {
                // Genie series
                args.version = 1;
                args.value = [{ ...noDisturb[0], ...noDisturbArgs }];
            } else {
                // M9, etc.
                args.no_disturb = [{ ...noDisturb[0], ...noDisturbArgs }];
            }

            this.log.info(`mow_regular (no_disturb): ${JSON.stringify(noDisturbArgs)}`);
            await this.doDeviceCommand('mow_regular', args);
        }
    }

    /**
     * Start custom area (aka. zone) mowing
     *
     * @param {Array<number>} id Custom area ID
     */
    async doCustomAreaMowStart(id) {
        this.log.info(`custom_area_mow_start: ${JSON.stringify(id)}`);
        await this.doDeviceCommand('custom_area_mow_start', { id });
    }

    /**
     * Start ridable (aka. edge) mowing
     *
     * @param {number} id Custom area ID
     */
    async doRidableAreaMowStart(id) {
        this.log.info(`ridable_mow_start: ${JSON.stringify(id)}`);
        await this.doDeviceCommand('ridable_mow_start', { id });
    }

    /**
     * Save custom area(s) definition to Anthbot cloud
     *
     * @param {Array} customAreas List of area definitions
     * @returns success boolean
     */
    async doAreaSet(customAreas) {
        // Assume failure until verified and sent
        let success = false;

        // Overlay elements from the state onto existing custom areas so user only has to set
        // the items they are changing and rest will be preserved.

        // Variable named to match asyncSendServiceCommand data
        const custom_areas = this.validateCustomAreas(customAreas);

        if (!custom_areas) {
            this.log.error(`Bad area data: ${customAreas}`);
        } else {
            // Write the given custom area data
            await this.doDeviceCommand('area_set', { custom_areas });
            success = true;
        }
        return success;
    }

    /**
     * Set custom area cutter height
     *
     * @param {number} customAreaId Custom area ID
     * @param {number} cutterHeight Height
     */
    async doCutterHeightSet(customAreaId, cutterHeight) {
        const areaSetCommand = [{ cutter_height: cutterHeight, id: customAreaId }];
        await this.doAreaSet(areaSetCommand);
    }

    /**
     * Set custom area mow_head (cutting angle).
     * Use random value if none (or undefined) passed.
     *
     * @param {number} customAreaId Custom area ID
     * @param {number | undefined} mowHead Angle to set
     */
    async doMowHeadSet(customAreaId, mowHead = undefined) {
        const areaSetCommand = [
            typeof mowHead == 'undefined'
                ? this.randomMowHeadAreaCommand(customAreaId)
                : { mow_head: mowHead, id: customAreaId },
        ];
        this.log.info(`mow_head: ${JSON.stringify(areaSetCommand)}`);
        await this.doAreaSet(areaSetCommand);
    }

    /**
     * Return argument to randomise given custom area
     *
     * @param {number} customAreaId Custom area ID
     * @returns command object to pass to cloud
     */
    randomMowHeadAreaCommand(customAreaId) {
        const randomAngle = Math.floor(Math.random() * 180);
        this.log.debug(`New random mow_head for ${customAreaId}: ${randomAngle}`);
        return { mow_head: randomAngle, id: customAreaId };
    }

    /**
     * Helper function to set shadow state values
     */
    setShadowState() {
        // Get online state for use elsewhere
        this.isOnline = this.shadowState.online.value;

        // Get current mode here or offline override
        this.mode = this.isOnline ? this.shadowState.mode?.value : 'offline';
        this.setStateChanged(`status.mode`, this.mode);

        this.setStateChanged(`status.active_area`, JSON.stringify(this.shadowState.active_area.id));

        this.setStateChanged(`status.elec`, this.shadowState.elec.value);

        // Area & time can be in either of these shadow state proprties
        // TODO: check if this is actually true, or 'new' is for global mowing or just Genie?
        this.setStateChanged(`status.mowing_area`, this.shadowState.mowing_area.value);
        this.setStateChanged(`status.mowing_time`, this.shadowState.mowing_time.value);

        this.setStateChanged(`status.rtk_state`, this.shadowState.rtk?.state == 1);
        this.setStateChanged(`status.rtk_moved`, this.shadowState.rtk?.moved == 1);

        // map.area_id & map.plan_id are set only after map is load
        this.setStateChanged(`map.map_area`, this.shadowState.map?.map_area?.value);

        // In command folder as are read/write

        // Visual Inspection
        this.setStateChanged(`command.pobctl_level`, this.shadowState.device_config?.pobctl_level);
        this.setStateChanged(`command.pobctl_switch`, this.shadowState.device_config?.pobctl_switch);

        // Rain perception
        this.setStateChanged(`command.rain_switch`, this.shadowState.device_config?.rain_switch == 1);
        this.setStateChanged(`command.rain_continue_time`, this.shadowState.device_config?.rain_continue_time);

        this.setStateChanged(`command.volume`, this.shadowState.device_config?.volume);
    }

    /**
     * Get/set code list
     */
    async checkCodeList() {
        let success = true;
        try {
            this.codeList = await this.client?.asyncGetCodeList(this.sn, 1, 20 /* TODO: make configurable? */);
        } catch (error) {
            this.log.error(`Failed to fetch code list: ${error.message}`);
            success = false;
        }

        if (success) {
            this.log.debug(`code list:\n${JSON.stringify(this.codeList)}`);

            this.setStateChanged(`status.code_list`, JSON.stringify(this.codeList));

            const lastCode = this.codeList[0];
            this.setStateChanged(`status.last_code`, lastCode.code);
            this.setStateChanged(`status.last_code_text`, lastCode.event_message);
            this.setStateChanged(`status.last_code_type`, lastCode.code_type);
        }
    }

    /**
     * Make sure given area list is valid
     *
     * @param {Array} customAreas List of areas to validate
     * @returns Sanitised area list
     */
    validateCustomAreas(customAreas) {
        const outputAreas = [];

        if (!Array.isArray(customAreas)) {
            this.log.error(`Invalid custom areas: not an array`);
        } else {
            for (const area of customAreas) {
                let outArea;

                const existingArea = this.customAreasRaw.find(customArea => customArea.id === area.id);
                if (existingArea) {
                    this.log.debug(`Found existing area ${area.id} for merge: ${JSON.stringify(existingArea)}`);
                    outArea = { ...existingArea, ...area };
                    this.log.debug(`After merge ${area.id} is: ${JSON.stringify(outArea)}`);
                } else {
                    outArea = area;
                }

                // Assume area is good
                let isGood = true;
                if (typeof outArea.id !== 'number' || typeof outArea.name !== 'string') {
                    // Must have ID & name (I'm guessing)
                    this.log.error('Invalid custom area: id or name are bad/missing');
                    isGood = false;
                } else if (!Array.isArray(outArea.vertexs) || outArea.vertexs.length != 4) {
                    // vertexs must be an array of 4 co-ordinates or the Anthbot app will crash!
                    this.log.error('Invalid custom area: vertexs is not an array of 4 items');
                    isGood = false;
                } else {
                    let goodVertexs = 0;
                    for (const vertex of outArea.vertexs) {
                        if (
                            !Array.isArray(vertex) ||
                            vertex.length != 2 ||
                            typeof vertex[0] !== 'number' ||
                            typeof vertex[1] !== 'number'
                        ) {
                            this.log.error('Invalid custom area: vertex is not a co-ordinate');
                            break;
                        } else {
                            goodVertexs++;
                        }
                    }
                    if (goodVertexs != 4) {
                        isGood = false;
                    }
                }

                if (!isGood) {
                    // Something wrong with this area so return nothing
                    return;
                }
                outputAreas.push(outArea);
            }
        }

        return outputAreas;
    }

    /**
     * @param {string} checkAreasName Property name of the area objects to check against
     * @param {Array | undefined} passedToCheck Optional list to check instead of fetching from command state
     * @returns {Promise<Array | false>} List if good, false if not
     */
    async isGoodAreaList(checkAreasName, passedToCheck = undefined) {
        const listToCheck = passedToCheck
            ? passedToCheck
            : this.adapter.parseJsonList((await this.getStateAsync('command.area_list'))?.val);

        if (!listToCheck || !Array.isArray(listToCheck)) {
            this.log.error('Area list to check is not valid');
            return false;
        } else if (listToCheck.length == 0) {
            this.log.error('Area list is empty');
            return false;
        }

        const checkAreas = this?.[checkAreasName];
        // Each area in array must be a known custom area ID
        checkArea: for (const areaToCheck of listToCheck) {
            for (const checkArea of checkAreas) {
                if (checkArea.id === areaToCheck) {
                    continue checkArea;
                }
            }
            // If we didn't continue, then we didn't find the area ID in our info list, so it's not good
            this.log.warn(`Invalid area list: ${areaToCheck} not found in check list`);
            return false;
        }

        return listToCheck;
    }

    /**
     * Compare 2 IDs are 'close'. This is because sometimes timestamps within a few seconds
     *
     * @param {number} id1 - First ID
     * @param {number} id2 - Second ID
     */
    planIdMatch(id1, id2) {
        return Math.abs(Number(id1) - Number(id2)) < 5;
    }

    /**
     * Check for and load any map updates from the cloud
     */
    async checkMapUpdates() {
        if (
            !this.mapLoaded /* Force load at startup */ ||
            this.shadowState.map.area_id != (await this.getStateAsync('map.area_id'))?.val ||
            !this.planIdMatch(this.shadowState.map.plan_id, (await this.getStateAsync('map.plan_id'))?.val)
        ) {
            // areaId does not match from time of last fetch so we need to update map
            this.log.info(`${!this.mapLoaded ? 'Startup' : 'change detected'}, fetching new map info`);

            let deviceMapFiles;
            try {
                deviceMapFiles = await this.client?.asyncGetDeviceMap(this.sn);
            } catch (error) {
                this.log.error(`Error fetching device map: ${error.message}`);
            }

            const areaSetting = deviceMapFiles?.['area_setting.json']?.content;
            this.log.debug(`area_setting.json: ${JSON.stringify(areaSetting)}`);

            // Custom Areas (aka. zones)
            this.customAreasRaw = areaSetting?.custom_areas;
            if (!Array.isArray(this.customAreasRaw)) {
                this.log.debug(`custom_areas is not an array - setting empty`);
                this.customAreasRaw = [];
            }
            this.setStateChanged(`map.custom_areas.raw`, JSON.stringify(this.customAreasRaw));

            // Copy raw areas to add our details without polluting customAreasRaw which are stored in the cloud
            this.customAreas = await this.populateDeviceFromStates(this.customAreasRaw);
            this.log.debug(`customAreas (after state population): ${JSON.stringify(this.customAreas)}`);

            // Ridable Areas (aka. edges)
            this.ridableAreas = areaSetting?.ridable_areas;
            this.log.debug(`ridableAreas: ${JSON.stringify(this.ridableAreas)}`);

            this.setStateChanged(`map.ridable_areas.raw`, JSON.stringify(this.ridableAreas));

            const readOnlyStates = [
                ['last_start', 'number', 'value.time', 'Start time of last job including this area'],
                ['last_finish', 'number', 'value.time', 'End time of last job including this area'],
                ['estimated_elapsed_time', 'number', 'time.span', 'Elapsed time to mow this area', 's'],
                ['estimated_elec', 'number', 'value.battery', 'Elec (battery) used mowingthis area', '%'],
            ];

            const commandStates = [
                // Command buttons
                ['custom_area_mow_start', 'boolean', 'button.start', 'Start a task mowing this single area'],

                // Set mow_head (cutting direction) randomly
                ['mow_head_random', 'boolean', 'switch.enable', 'Set mow_head (cutting direction) randomly'],

                // Current values
                ['mow_head', 'number', 'level', 'Current mow_head (cutting direction)', '°'],
                ['cutter_height', 'number', 'level', 'Current cutter_height', 'mm'],

                // List of alternating mow_head (aka. cutting direction) angles.
                // If set the adapter will move to the next angle in the list when mowing of
                // the given custom area completes successfully.
                [
                    'mow_head_alts',
                    'array',
                    'list',
                    `Alternates for mow_head (cutting direction) setting (array of angles, e.g. '[0, 90, 120]')`,
                ],

                // Scheduling
                ['schedule_enabled', 'boolean', 'switch.enable', 'Enable adapter scheduling for this area'],
                ['schedule_priority', 'number', 'level', 'Priority (lowest number is handled first)'],
                [
                    'schedule_days_since_last',
                    'number',
                    'time.span',
                    'Number of days between mowing (0 = cut every day)',
                ],
            ];

            for (const customArea of this.customAreas) {
                // Use setObject here so if the name changes online it gets updated in IoB
                const customAreaChannelStateId = `${this.id}.map.custom_areas.${sanitizeId(customArea.id)}`;
                await this.adapter.extendObject(customAreaChannelStateId, {
                    type: 'channel',
                    common: {
                        name: customArea.name,
                    },
                    native: {},
                });

                await this.adapter.createStatesFromList(customAreaChannelStateId, readOnlyStates);
                await this.adapter.createStatesFromList(customAreaChannelStateId, commandStates, true);

                // Set states that come from the cloud
                await this.setStateChanged(
                    `map.custom_areas.${sanitizeId(customArea.id)}.mow_head`,
                    customArea.mow_head,
                );
                await this.setStateChanged(
                    `map.custom_areas.${sanitizeId(customArea.id)}.cutter_height`,
                    customArea.cutter_height,
                );
            }

            // Go find all the custom area channels that aren't in the current list and delete them
            const existingChannels = await this.adapter.getChannelsOfAsync(`${this.id}`);
            this.log.debug(`Existing custom area channels: ${JSON.stringify(existingChannels)}`);
            for (const existingChannel of existingChannels) {
                const channelId = existingChannel._id.split('.').pop();
                if (!this.customAreas.find(area => sanitizeId(area.id) == channelId)) {
                    this.log.debug(
                        `Deleting custom area channel ${existingChannel._id} as it's no longer in the map info`,
                    );
                    await this.adapter.delObjectAsync(existingChannel._id, { recursive: true });
                }
            }

            this.timeSetting = deviceMapFiles?.['time_setting.json']?.content;
            this.log.debug(`time_setting.json: ${JSON.stringify(this.timeSetting)}`);

            if (this.timeSetting) {
                this.setStateChanged(`command.do_not_disturb`, this.timeSetting.no_disturb?.[0].active == 1);
                this.setStateChanged(`command.do_not_disturb_start`, this.timeSetting.no_disturb?.[0].start_time);
                this.setStateChanged(`command.do_not_disturb_end`, this.timeSetting.no_disturb?.[0].end_time);
            }

            // Only save the area/map/plan IDs after map load to use for check detection
            this.setStateChanged('map.area_id', areaSetting.area_id);
            this.setStateChanged('map.plan_id', this.timeSetting?.plan_id);

            if (deviceMapFiles) {
                this.mapLoaded = true;
            }
        }
    }

    /**
     * See if there's a recent rain related code and:
     * - Note it's raining
     * - Set a timestamp to prevent schedule from starting for a while
     *
     * Note that 'command.rain_continue_time' state is not loaded at startup, but that's
     * ok because the first call to checkRainStatus will therefore think it's not
     * raining and set/reset it accordingly.
     */
    async checkRainStatus() {
        if (!this.isRainPause && Array.isArray(this.codeList)) {
            // Go find the last timestamp for rain code
            const rainCode = this.codeList.find(code => RAIN_CODES.includes(code.code));
            if (rainCode) {
                this.log.debug(`rainCode: ${JSON.stringify(rainCode)}`);
                const lastRain = this.codeTimestamp(rainCode);
                this.rainRetryTimestamp =
                    lastRain + (await this.getStateAsync('command.rain_continue_time'))?.val * 1000;
                if (this.rainRetryTimestamp > Date.now()) {
                    this.log.info(
                        `Rain detected, pausing tasks until ${new Date(this.rainRetryTimestamp).toLocaleTimeString()}`,
                    );
                }
            } else {
                this.rainRetryTimestamp = 0;
            }
            await this.setStateChanged(`iob_schedule.rain_retry_timestamp`, this.rainRetryTimestamp);
        }
    }

    /**
     * Return timestamp for given codeList entry
     *
     * @param {object} code Entry from codeList
     * @returns Timestamp of the code entry
     */
    codeTimestamp(code) {
        // Add 'Z' because the time is UTC

        return Date.parse(`${code.create_time}Z`);
    }

    /**
     * Check if custom area task has just started/finished
     */
    async checkCustomAreaTask() {
        // Figure out if device has just started/finished a custom area task & set states accordingly
        if (
            Array.isArray(this.codeList) &&
            !this.isCustomAreaMowing &&
            this.mode == 'zonemowing' &&
            Array.isArray(this.shadowState.active_area.id)
        ) {
            // Currently mowing at least one custom area
            this.log.info(`new custom area task detected: ${JSON.stringify(this.shadowState.active_area.id)}`);
            this.isCustomAreaMowing = true;

            // Go find the last "The robot is going to the designated area to mow" code (#1018) to get timestamp
            const startCode = this.codeList.find(code => code.code === CUSTOM_AREA_TASK_START_CODE);
            if (!startCode) {
                this.log.warn(`Could not find start code while custom area mowing`);
            } else {
                this.log.debug(`startCode for custom area mowing: ${JSON.stringify(startCode)}`);

                const lastStart = this.codeTimestamp(startCode);

                // Set start time for each active area
                for (const activeAreaId of this.shadowState.active_area.id) {
                    await this.setCustomAreaProperty(activeAreaId, { lastStart });
                }

                // If start time is close (within 2 * polling interval) track battery for estimate
                if (Date.now() - lastStart < POLLING_INTERVAL_MS * 2) {
                    // Keep count of how much 'elec' changes during this task.
                    // Not ideal, but as we poll regularly probably easier than taking
                    // a start and end value and trying to account for charging, etc.
                    this.customAreaMowingElec = 0;
                    this.lastElec = this.shadowState.elec.value;

                    this.log.debug(`Caught custom area mowing task in time to monitor elec: ${this.lastElec}`);
                } else {
                    // We have noticed this start event too late
                    this.log.warn(
                        `Caught custom area mowing task too late to monitor elec: ${JSON.stringify(this.shadowState.active_area.id)}`,
                    );
                    this.customAreaMowingElec = undefined;
                }
            }
        } else if (
            Array.isArray(this.codeList) &&
            this.isCustomAreaMowing &&
            Array.isArray(this.shadowState.active_area.id)
        ) {
            // If we can find a "Task finished" code (#1014) before (which is chronologically after)
            // the previous start code (#1018) then we're done
            const startIndex = this.codeList.findIndex(code => code.code === CUSTOM_AREA_TASK_START_CODE);
            let endIndex = this.codeList.findIndex(code => TASK_END_CODES.includes(code.code));

            // TODO: should we check the timestamp of the battery state?
            if (
                (endIndex < 0 || endIndex > startIndex) &&
                this.shadowState.elec.value > MINIMUM_ELEC_FOR_CUSTOM_AREA_START
            ) {
                // Sometimes the endIndex is missing so if this is the case make do with a charging code
                // *IF* it is recent (within 2 * polling interval) and the battery isn't empty
                const chargeIndex = this.codeList.findIndex(code => CHARGING_CODES.includes(code.code));
                if (chargeIndex >= 0) {
                    const lastCharge = this.codeTimestamp(this.codeList[chargeIndex]);
                    if (Date.now() - lastCharge < POLLING_INTERVAL_MS * 2) {
                        this.log.warn(
                            `No task end code found, but mower returning to charge with ${this.shadowState.elec.value}% battery - assuming task finished`,
                        );
                        endIndex = chargeIndex;
                    }
                }
            }

            // TODO: should we check the timestamp of the battery state?
            if (
                (endIndex < 0 || endIndex > startIndex) &&
                this.shadowState.elec.value == 100 &&
                this.mode == 'charge'
            ) {
                // endIndex still not found, but mower is 100% charged and still stitting on the dock
                // so it must think job is done.
                // TODO: what about when paused?
                const chargeIndex = this.codeList.findIndex(code => CHARGING_CODES.includes(code.code));
                if (chargeIndex >= 0) {
                    this.log.warn('No task end code found, but mower seems idle - assuming task finished');
                    endIndex = chargeIndex;
                }
            }

            if (endIndex >= 0 && (endIndex < startIndex || startIndex === -1)) {
                this.log.debug('Custom area mowing end code found');

                this.isCustomAreaMowing = false;
                this.log.info(`custom area task finished: ${JSON.stringify(this.shadowState.active_area.id)}`);

                const lastFinish = this.codeTimestamp(this.codeList[endIndex]);

                // Set finish time for each active area
                for (const activeAreaId of this.shadowState.active_area.id) {
                    await this.setCustomAreaProperty(activeAreaId, { lastFinish });
                }

                // If this was a single custom area, we can set the estimated time to complete
                if (this.shadowState.active_area.id.length == 1) {
                    // TODO: make sure there were no errors between start and end codes
                    // TODO: make sure battery was close to full when starting
                    // TODO: possibly throw this number away when area vertexes change
                    const singleAreaId = this.shadowState.active_area.id[0];
                    const singleArea = this.customAreas.find(customArea => customArea.id == singleAreaId);
                    if (!singleArea) {
                        this.log.error(`Could not find custom area ID ${singleAreaId} when checking alternates`);
                    } else {
                        const startTime = singleArea.lastStart;
                        if (!startTime || !(Number(startTime) > 0)) {
                            this.log.warn(`Single area ID ${singleAreaId} has no start time`);
                        } else {
                            const estimatedElapsedTime = (lastFinish - Number(startTime)) / 1000;
                            await this.setCustomAreaProperty(singleAreaId, { estimatedElapsedTime });
                        }

                        if (typeof this.customAreaMowingElec == 'number') {
                            // We have been tracking elec (battery) usage so record that
                            const estimatedElec = this.customAreaMowingElec;
                            await this.setCustomAreaProperty(singleAreaId, { estimatedElec });
                        }
                    }
                }

                await this.checkCustomAreaAlternates();
            } else if (!['zonemowing', 'backtodock', 'charge'].includes(this.mode)) {
                // Not custom area mowing (or charging part way through) but didn't find a "Task finished" code
                this.log.warn(`Custom area mowing looks done but no "Task finished" code found`);
                this.isCustomAreaMowing = false;
            } else if (typeof this.customAreaMowingElec == 'number' && this.lastElec > this.shadowState.elec.value) {
                // Device is still custom area mowing and has a reduced 'elec' (battery) level
                this.customAreaMowingElec += this.lastElec - this.shadowState.elec.value;
                this.lastElec = this.shadowState.elec.value;
                this.log.debug(`Custom area mowing task has now consumed ${this.customAreaMowingElec} elec`);
            }
        }
    }

    /**
     * Check for, and cycle through alternate parameters for custom areas
     */
    async checkCustomAreaAlternates() {
        // Build an array of commands for area_set
        const areaSetCommand = [];

        const activeCustomAreas = this.customAreas.filter(customArea => {
            return this.shadowState.active_area.id.includes(customArea.id);
        });

        this.log.debug(`activeCustomAreas: ${JSON.stringify(activeCustomAreas)}`);

        for (const customArea of activeCustomAreas) {
            if (customArea.mowHeadRandom) {
                this.log.info(`New random mow head for ${customArea.id}`);
                areaSetCommand.push(this.randomMowHeadAreaCommand(customArea.id));
            } else {
                const mowHeadAlts = customArea.mowHeadAlts;
                // The check is for > 0, not > 1 because that way if there's a single alternate
                // that doesn't match current value it will get set.
                if (Array.isArray(mowHeadAlts) && mowHeadAlts.length > 0) {
                    // Remember findIndex returns -1 on no match
                    let setIndex = mowHeadAlts.findIndex(angle => angle == customArea.mow_head) + 1;
                    if (setIndex >= mowHeadAlts.length) {
                        // Wrap around to the first alternate
                        setIndex = 0;
                    }
                    const newMowHead = mowHeadAlts[setIndex];
                    this.log.info(`Cycling to next mow head for ${customArea.id}: ${newMowHead}`);
                    areaSetCommand.push({ mow_head: newMowHead, id: customArea.id });
                }
            }
        }

        if (areaSetCommand.length > 0) {
            await this.doAreaSet(areaSetCommand);
        }
    }

    /**
     * Iterate through custom areas and commence custom area mowing task if applicable
     */
    async checkCustomAreaSchedule() {
        // Get the start of today in ms
        const now = new Date();
        const today0000 = new Date(now);
        today0000.setHours(0, 0, 0, 0);

        // Figure out which areas are ready to mow today
        const customAreasLeftToday = [];
        let estimatedTimeLeftTodoToday = 0;
        for (const customArea of this.customAreas) {
            if (
                customArea.scheduleEnabled &&
                Number(customArea.scheduleDaysSinceLast) >= 0 &&
                customArea.lastFinish > 0 &&
                !(Number(customArea.lastStart) > today0000.getTime())
            ) {
                // The area has schedule enabled and a valid lastFinish
                const daysSinceLast = Math.ceil((today0000.getTime() - customArea.lastFinish) / MS_IN_DAY);
                // Remember zero scheduleDaysSinceLast means cut every day, 1 means leave 1 day between cuts, etc.
                customArea.currentDaysOverdue = daysSinceLast - customArea.scheduleDaysSinceLast - 1;

                this.log.debug(
                    `since last/schedule/overdue days (lastStart/lastFinish) for ${customArea.id}: ${daysSinceLast}/${customArea.scheduleDaysSinceLast}/${customArea.currentDaysOverdue} (${customArea.lastStart}/${customArea.lastFinish})`,
                );

                if (customArea.currentDaysOverdue >= 0) {
                    // This area needs cutting
                    this.log.debug(`Task required for area ID ${customArea.id}`);

                    // How long will it take?
                    let msRequired = Number(customArea.estimatedElapsedTime) * 1000;
                    if (!msRequired) {
                        msRequired = SCHEDULE_MS_REQUIRED_FOR_UNKNOWN_CUSTOM_AREA;
                        this.log.debug(
                            `No estimate of elapsed time for area ID ${customArea.id}, defaulting to ${msRequired}`,
                        );
                    }
                    // 'Temporary' estimate for schedule
                    customArea.estimatedElapsedTimeToUse = msRequired;

                    customAreasLeftToday.push(customArea);

                    estimatedTimeLeftTodoToday += msRequired;
                }
            }
        }

        // Sort areas by priority & days overdue, the latter being more important
        customAreasLeftToday.sort((a, b) => {
            return a.currentDaysOverdue == b.currentDaysOverdue
                ? // Lower schedule priority comes first
                  a.schedulePriority - b.schedulePriority
                : // Higher days overdue comes first
                  b.currentDaysOverdue - a.currentDaysOverdue;
        });

        // Update custom area list/estimated time states if changed
        const secondsLeftTodoToday = estimatedTimeLeftTodoToday / 1000;
        const customAreaIdsLeftToday = customAreasLeftToday.map(customArea => {
            return customArea.id;
        });
        this.log.debug(
            `Custom areas todo/time today: ${JSON.stringify(customAreaIdsLeftToday)}/${secondsLeftTodoToday}`,
        );
        await this.setStateChanged('iob_schedule.custom_areas_left_today', JSON.stringify(customAreaIdsLeftToday));
        await this.setStateChanged('iob_schedule.estimated_time_left_todo_today', secondsLeftTodoToday);

        if (
            customAreasLeftToday.length == 0 || // Nothing to do
            this.isRainPause || // It's raining
            this.isBusy || // Already busy
            // TODO: improve the battery state check?
            (this.mode == 'charge' && this.shadowState.elec.value < 96) || // Device isn't fully charged
            (this.mode == 'backtodock' && this.shadowState.elec.value < MINIMUM_ELEC_FOR_CUSTOM_AREA_START) // Device is available but battery too low to start new zone
        ) {
            return;
        }

        // Device is available to start work
        this.log.debug(`checkCustomAreaSchedule... work needed & device available`);

        const doNotDisturbStart = today0000.getTime() + this.doNotDisturbStart * 1000;
        const doNotDisturbEnd = today0000.getTime() + this.doNotDisturbEnd * 1000;

        if (this.doNotDisturbActive && now.getTime() > doNotDisturbStart && now.getTime() < doNotDisturbEnd) {
            this.log.debug(`checkCustomAreaSchedule... in active do not disturb period`);
            return;
        }

        // Get dawn/dusk times to figure out if a task should start though
        const suncalcTimes = SunCalc.getSunTimes(
            now,
            this.adapter.sysConfig?.common.latitude,
            this.adapter.sysConfig?.common.longitude,
        );

        if (
            now.getTime() < suncalcTimes.civilDawn.ts + SCHEDULE_MS_WAIT_AFTER_DAWN ||
            now.getTime() > suncalcTimes.civilDusk.ts
        ) {
            // Before dawn or after dusk
            this.log.debug(`checkCustomAreaSchedule... time now is before dawn (+delay) or after dusk`);
            return;
        }

        let startAreaId;
        // customAreasLeftToday is already sorted by priority so start first one
        // that is able to be completed before dusk or (only if active) do not disturb period starts
        for (const customArea of customAreasLeftToday) {
            // Estimate if it's possible before dusk (use estimatedElapsedTimeToUse from above)...
            if (now.getTime() + customArea.estimatedElapsedTimeToUse > suncalcTimes.civilDusk.ts) {
                this.log.debug(`Not enough time before dusk for ID ${customArea.id}`);
            } else if (
                this.doNotDisturbActive &&
                now.getTime() < doNotDisturbStart &&
                now.getTime() + customArea.estimatedElapsedTimeToUse > doNotDisturbStart
            ) {
                this.log.debug(`Not enough time before do not disturb starts for ID ${customArea.id}`);
            } else {
                startAreaId = customArea.id;
                // Found something so we're done with this loop
                break;
            }
        }

        if (startAreaId) {
            this.log.info(`Scheduled start for ID ${startAreaId} (best of ${JSON.stringify(customAreaIdsLeftToday)})`);
            await this.doCustomAreaMowStart([startAreaId]);
        }
    }
}

// Exports
module.exports = {
    AnthbotDevice,
    sanitizeId,
};
