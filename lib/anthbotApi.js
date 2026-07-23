/*
 * API client for Anthbot Genie cloud polling
 * NodeJS port of the Python api.py module by @vincentjanv...
 * https://github.com/vincentjanv/anthbot_genie_ha
 * ... with a few addions/changes of course ;)
 */

const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const tarStream = require('tar-stream');
const { URLSearchParams } = require('node:url');

// Constants
const DEFAULT_API_HOST = 'api.anthbot.com';
const DEFAULT_IOT_REGION = 'us-east-1';
const DEFAULT_IOT_ENDPOINT = 'a2bhy9nr7jkgaj-ats.iot.us-east-1.amazonaws.com';
const CN_NORTHWEST_IOT_ENDPOINT = 'a2iw0czxjowiip-ats.iot.cn-northwest-1.amazonaws.com.cn';

const AWS_ACCESS_KEY_DEFAULT = 'AKIAV2C4RVIAOLEXB545';
const AWS_SECRET_KEY_DEFAULT = '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';

const AWS_ACCESS_KEY_CN = 'AKIAWJ3KIT7IV6AHMJ5V';
const AWS_SECRET_KEY_CN = '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';

const AWS_ACCESS_KEY_CN_NORTHWEST = 'AKIAYVWVSSRF7W5YWI74';
const AWS_SECRET_KEY_CN_NORTHWEST = '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';

const CLIENT_USER_AGENT = 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0';

const REQUEST_TIMEOUT = 15000; // 15 seconds

// Redact these properties from objects in verbose logging
const PROPERTIES_TO_REDACT = [
    'access_token',
    'accessKeyId',
    'access_key_id',
    'Authorization',
    'password',
    'refresh_token',
    'secretAccessKey',
    'sessionToken',
    'session_token',
    'username',
    'x-amz-security-token',
];

/**
 * Client for Anthbot cloud account endpoints
 */
class AnthbotCloudApiClient {
    /**
     * @param {object} options - Configuration options
     */
    constructor(options) {
        this.endpointHost = DEFAULT_API_HOST;
        this.authHeaders = {
            Accept: 'application/json, text/plain, */*',
            version: 'v2',
            language: 'en',
            'User-Agent': CLIENT_USER_AGENT,
        };
        this.bearerToken = null;
        this.verboseLogger = options?.verboseLogger;
        this.setTimeout = typeof options?.setTimeout == 'function' ? options.setTimeout : setTimeout;
        // Array for cache of clients for each serial number we interact with
        this.shadowClients = {};
    }

    /**
     * Stringify an object while redacting sensitive properties.
     * It doesn't matter if this is slightly inefficient because it's only used
     * when debug (verbose logging) is on which should never be the case in
     * production.
     *
     * @param {object} inObj Input object
     * @returns Stringified object with sensitive properties redacted
     */
    redactAndStringify(inObj) {
        return JSON.stringify(
            inObj,
            (key, value) => {
                return PROPERTIES_TO_REDACT.includes(key) ? '***REDACTED***' : value;
            },
            2,
        );
    }

    /**
     * Fetch URL and return body
     *
     * @param {string} url - URL to fetch
     * @param {object} options - Options (headers, etc)
     * @returns Body returned by remote server
     */
    async fetch(url, options = {}) {
        const controller = new AbortController();
        const timeout = REQUEST_TIMEOUT;
        const timeoutId = this.setTimeout(() => controller.abort(), timeout);

        if (this.verboseLogger) {
            this.verboseLogger(`[VERBOSE] >>> ${options.method || 'GET'} ${url}`);
            if (options.headers) {
                this.verboseLogger(`[VERBOSE] Headers: ${this.redactAndStringify(options.headers)}`);
            }
            if (options.body) {
                this.verboseLogger(`[VERBOSE] Body: ${this.redactAndStringify(options.body)}`);
            }
        }

        // If body is given and an object, stringify it... shame fetch doesn't do this for us
        if (typeof options.body == 'object') {
            options.body = JSON.stringify(options.body);
        }

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });

            if (this.verboseLogger) {
                this.verboseLogger(`[VERBOSE] <<< ${response.status} ${response.statusText}`);
                this.verboseLogger(
                    `[VERBOSE] Response Headers: ${this.redactAndStringify(Object.fromEntries(response.headers.entries()))}`,
                );

                // Clone response to read body without consuming original
                const responseClone = response.clone();
                try {
                    const contentType = responseClone.headers.get('content-type') || '';
                    if (contentType.includes('application/json') || contentType.startsWith('text/')) {
                        const responseBody = await responseClone.text();
                        if (responseBody) {
                            try {
                                const jsonBody = JSON.parse(responseBody);
                                this.verboseLogger(
                                    `[VERBOSE] Response Body (JSON): ${this.redactAndStringify(jsonBody)}`,
                                );
                            } catch {
                                const maxLoggingLength = 512;
                                if (responseBody.length > maxLoggingLength) {
                                    this.verboseLogger(
                                        `[VERBOSE] Response body (truncated): ${responseBody.substring(0, maxLoggingLength)}...`,
                                    );
                                } else {
                                    this.verboseLogger(`[VERBOSE] Response body (raw): ${responseBody}`);
                                }
                            }
                        }
                    } else {
                        const contentLength = responseClone.headers.get('content-length');
                        if (contentLength) {
                            this.verboseLogger(`[VERBOSE] Binary response body of ${contentLength} bytes`);
                        } else {
                            this.verboseLogger(`[VERBOSE] Binary response body`);
                        }
                    }
                } catch (err) {
                    this.verboseLogger(`[VERBOSE] Could not read response body: ${err.message}`);
                }
            }

            return response;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Login and return bearer token
     *
     * @param {string} username - Username
     * @param {string} password - Password
     * @param {number} areaCode - Country/region code
     */
    async asyncLogin(username, password, areaCode) {
        const url = `https://${this.endpointHost}/api/v1/login`;
        const headers = {
            Accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            version: 'v2',
            language: 'en',
            'User-Agent': CLIENT_USER_AGENT,
        };
        const body = { username, password, areaCode };

        const response = await this.fetch(url, {
            method: 'POST',
            headers,
            body,
        });

        if (response.status !== 200) {
            throw new Error(`Login failed (${response.status})`);
        }

        let data;
        try {
            // eslint-disable-next-line jsdoc/check-tag-names
            data = /** @type {{code: number, data?: object | null}} */ (await response.json());
        } catch {
            throw new Error('Invalid JSON response from login');
        }

        if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid login payload type');
        } else if (data.code !== 0) {
            throw new Error(`Login rejected: code=${this.redactAndStringify(data.code)}`);
        }

        const tokenData = data.data;
        if (typeof tokenData !== 'object' || tokenData === null) {
            throw new Error('Login payload missing data object');
        }

        const accessToken = tokenData.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
            throw new Error('Login payload missing access_token');
        }

        const bearerToken = `Bearer ${accessToken}`;
        this.bearerToken = bearerToken;
        this.authHeaders['Authorization'] = bearerToken;
    }

    /**
     * Fetch JSON and resolve the service-level payload data.
     *
     * @param {string} url URL to fetch from
     * @param {RequestInit} [options] Request options (method, headers, body, etc.)
     * @returns {Promise<object | null>} Payload data from the response
     */
    async fetchPayloadData(url, options = {}) {
        // GET is default
        if (!options.method) {
            options.method = 'GET';
        }

        // Always add our auth headers
        options.headers = { ...this.authHeaders, ...options.headers };

        // Check headers given (or added above) have the Authorization (sic.)
        if (!Object.prototype.hasOwnProperty.call(options.headers, 'Authorization')) {
            throw new Error('Missing Authorization header');
        }

        const response = await this.fetch(url, options);
        if (response.status !== 200) {
            const body = await response.text();
            throw new Error(`Request to ${url} failed (${response.status}): ${body.slice(0, 300)}`);
        }

        let payload;
        try {
            // eslint-disable-next-line jsdoc/check-tag-names
            payload = /** @type {{code: number, data?: object | null}} */ (await response.json());
        } catch {
            throw new Error(`Invalid JSON response from ${url}`);
        }

        if (typeof payload !== 'object' || payload === null) {
            throw new Error(`Invalid API payload from ${url}`);
        } else if (payload.code !== 0) {
            throw new Error(`API returned code=${payload.code} from ${url}`);
        }
        return payload.data;
    }

    /**
     * Fetch account-bound Anthbot devices
     *
     * @returns {Promise<{alias: string, sn: string, name: string}[]>} - List of devices
     */
    async asyncGetBoundDevices() {
        const url = `https://${this.endpointHost}/api/v1/device/bind/list`;

        return await this.fetchPayloadData(url);
    }

    /**
     * Fetch latest messages
     * Returns only last message by default
     *
     * @param {string} serialNumber - Device serial number
     * @param {number} pageNum - Page number
     * @param {number} pageSize - Page size
     * @returns {Promise<Array>} Latest messages
     */
    async asyncGetCodeList(serialNumber, pageNum = 1, pageSize = 1) {
        // TODO: allow language other than English?
        const url = `https://${this.endpointHost}/api/v1/device/v2/code/list?sn=${serialNumber}&pagenum=${pageNum}&pagesize=${pageSize}&language=English`;

        return (await this.fetchPayloadData(url))?.data;
    }

    /**
     * Get verification token for presigned URL retrieval
     *
     * @param {string} serialNumber - Device serial number
     * @returns {string} - Verification token
     */
    buildVerificationToken(serialNumber) {
        const unixTimestamp = Math.floor(Date.now() / 1000);
        const tokenSuffix = unixTimestamp.toString();
        const tokenPrefix = crypto.createHash('md5').update(`${serialNumber}${tokenSuffix}`, 'utf8').digest('hex');
        return `${tokenPrefix}${tokenSuffix}`;
    }

    /**
     * Fetch account-bound Anthbot devices
     *
     * @param {string} serialNumber - Device serial number
     * @param {string} filename - File name
     * @param {string} category - Category
     * @param {string} sub_category - Sub category
     * @returns {Promise<string>} - URL for the requested file
     */
    async asyncGetPresignedUrl(serialNumber, filename, category, sub_category) {
        const params = new URLSearchParams({
            filename,
            sn: serialNumber,
            category,
            sub_category,
            verification_token: this.buildVerificationToken(serialNumber),
        });
        const url = `https://${this.endpointHost}/api/v1/device/v2/presigned_url?${params}`;

        return (await this.fetchPayloadData(url))?.presigned_url;
    }

    /**
     * Decodes a TAR.GZ archive from a Buffer and returns an array of file entries with filename, type and content.
     *
     * @param {Buffer} buffer - The TAR.GZ buffer to decode
     * @returns {Promise<Array<{ filename: string; type: 'json' | 'blob'; content: unknown }>>} - Array of file contents
     */
    decodeTgzBuffer(buffer) {
        return new Promise((resolve, reject) => {
            const results = [];
            const extract = tarStream.extract();

            extract.on('entry', (header, stream, next) => {
                if (this.verboseLogger) {
                    this.verboseLogger(`Processing entry: ${this.redactAndStringify(header)}`);
                }

                if (header.type !== 'file') {
                    stream.resume();
                    return next();
                }

                const chunks = [];
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => {
                    const fileBuffer = Buffer.concat(chunks);
                    const filename = header.name || '';
                    let entryType = 'blob';
                    let content = fileBuffer;

                    if (filename.toLowerCase().endsWith('.bin')) {
                        // Do nothing as entryType and content already set
                    } else if (filename.toLowerCase().endsWith('.json')) {
                        try {
                            content = JSON.parse(fileBuffer.toString());
                            entryType = 'json';
                        } catch (err) {
                            if (this.verboseLogger) {
                                this.verboseLogger(
                                    `Failed to parse JSON for ${filename}: ${err.message}; leaving as binary`,
                                );
                            }
                        }
                    } else {
                        if (this.verboseLogger) {
                            this.verboseLogger(`Unknown archive file type for ${filename}; leaving as binary`);
                        }
                    }

                    results[filename] = { type: entryType, content };
                    next();
                });
                stream.on('error', reject);
            });

            extract.on('finish', () => resolve(results));
            extract.on('error', reject);

            const gunzip = zlib.createGunzip();
            gunzip.on('error', reject);
            gunzip.pipe(extract);
            gunzip.end(buffer);
        });
    }

    /**
     * Fetch device map
     *
     * @param {string} serialNumber - Device serial number
     * @returns {Promise<Array<{ filename: string; type: 'json' | 'blob'; content: unknown }>>} - Decoded map data
     */
    async asyncGetDeviceMap(serialNumber) {
        const url = await this.asyncGetPresignedUrl(
            serialNumber,
            `map_manager_${serialNumber}.tar.gz`,
            'device',
            'map',
        );
        const response = await this.fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/gzip, application/octet-stream, */*',
            },
        });

        if (response.status !== 200) {
            throw new Error(`Device map download failed (${response.status})`);
        }

        const deviceMapFiles = await this.decodeTgzBuffer(Buffer.from(await response.arrayBuffer()));

        if (typeof deviceMapFiles?.['area_setting.json'] == 'undefined') {
            // No area setting in map manager...
            if (this.verboseLogger) {
                this.verboseLogger(`No area_setting.json for ${serialNumber}`);
            }
            // .. try to fetch from it's own file
            const url = await this.asyncGetPresignedUrl(serialNumber, `area_${serialNumber}.txt`, 'device', 'area');
            const response = await this.fetch(url, {
                method: 'GET',
                headers: {
                    'Accept-Encoding': 'gzip',
                },
            });

            if (response.status !== 200) {
                throw new Error(`Device area download failed (${response.status})`);
            }

            // eslint-disable-next-line jsdoc/check-tag-names
            const content = /** @type {object} */ (await response.json());

            // Massage to add the area_id (copy from time)
            content.area_id = content.area_time;

            deviceMapFiles['area_setting.json'] = {
                content,
            };
        }

        if (typeof deviceMapFiles?.['time_setting.json'] == 'undefined') {
            // No area setting in map manager...
            if (this.verboseLogger) {
                this.verboseLogger(`No time_setting.json for ${serialNumber}`);
            }
            // .. try to fetch from it's own file
            const url = await this.asyncGetPresignedUrl(
                serialNumber,
                `appointment_${serialNumber}.json`,
                'device',
                'appointment',
            );
            const response = await this.fetch(url, {
                method: 'GET',
                headers: {
                    'Accept-Encoding': 'gzip',
                },
            });

            if (response.status !== 200) {
                throw new Error(`Device appointment download failed (${response.status})`);
            }

            // eslint-disable-next-line jsdoc/check-tag-names
            const content = /** @type {object} */ (await response.json());

            /*
             ** Massage actual appointment file into timeSetting format:
             ** - Find 'workmode: 0' and create no_disturb entry from that.
             */
            content.no_disturb = [
                content.value?.find(value => {
                    return value.workmode == 0;
                }),
            ];

            // Copy appointment_time (as string) to plan_id to have something to check for changes
            content.plan_id = `${content.appointment_time}`;

            deviceMapFiles['time_setting.json'] = {
                content,
            };
        }

        return deviceMapFiles;
    }

    /**
     * Fetch device cloud region metadata
     *
     * @param {string} serialNumber - Device serial number
     * @returns {Promise<{regionName: string; iotEndpoint: string}>} - Region metadata
     */
    async asyncGetDeviceRegion(serialNumber) {
        if (this.verboseLogger) {
            this.verboseLogger(`Fetching device region for ${serialNumber}`);
        }

        const url = `https://${this.endpointHost}/api/v1/device/v2/region`;
        const params = new URLSearchParams({ sn: serialNumber });
        const data = await this.fetchPayloadData(`${url}?${params}`);

        if (typeof data !== 'object' || data === null) {
            throw new Error('Device region payload missing data object');
        }

        const regionName = data.region_name;
        const iotEndpoint = data.iot_endpoint;
        if (typeof regionName !== 'string' || !regionName) {
            throw new Error('Device region missing region_name');
        }
        if (typeof iotEndpoint !== 'string' || !iotEndpoint) {
            throw new Error('Device region missing iot_endpoint');
        }

        const deviceRegion = { regionName, iotEndpoint };
        if (this.verboseLogger) {
            this.verboseLogger(`deviceRegion for ${serialNumber}: ${this.redactAndStringify(deviceRegion)}`);
        }
        return deviceRegion;
    }

    /**
     * Retrieve temporary IoT credentials for a device.
     *
     * @param {string} serialNumber - Device serial number
     * @returns {Promise<object>} - IoT credentials and expiration
     */
    async asyncGetDeviceIotCredentials(serialNumber) {
        const params = {
            sn: serialNumber,
            verification_token: this.buildVerificationToken(serialNumber),
        };

        const data = await this.fetchPayloadData(`https://${this.endpointHost}/api/v1/device/v2/iot/sts/arn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
        });

        if (typeof data !== 'object' || data === null) {
            throw new Error('IoT credentials payload missing data object');
        }

        const expiration = data.expiration;
        const expiresAt =
            expiration == null ? null : expiration > 2000000000 ? expiration * 1000 : Date.now() + expiration * 1000;

        const iotCredentials = {
            accessKeyId: data.access_key_id,
            secretAccessKey: data.secret_access_key,
            sessionToken: data.session_token,
            regionName: data.region_name,
            endpoint: data.endpoint,
            expiresAt,
        };
        if (this.verboseLogger) {
            this.verboseLogger(`IoT credentials for ${serialNumber}: ${this.redactAndStringify(iotCredentials)}`);
        }
        return iotCredentials;
    }

    /**
     * Ensure shadow client is initialized
     *
     * @param {string} serialNumber - Device serial number
     * @returns {Promise<void>}
     */
    async checkShadowClient(serialNumber) {
        let shadowClient = this.shadowClients[serialNumber];
        if (!shadowClient) {
            if (this.verboseLogger) {
                this.verboseLogger(`No shadow client for ${serialNumber}, creating one`);
            }
            const deviceRegion = await this.asyncGetDeviceRegion(serialNumber);
            this.shadowClients[serialNumber] = new AnthbotShadowApiClient({
                serialNumber,
                regionName: deviceRegion.regionName,
                iotEndpoint: deviceRegion.iotEndpoint,
                verboseLogger: this.verboseLogger,
                fetch: this.fetch.bind(this),
            });
            shadowClient = this.shadowClients[serialNumber];
        }

        // Get new credentials if whe have none or they have expired
        if (shadowClient.iotCredentialsExpired()) {
            if (this.verboseLogger) {
                this.verboseLogger(`No/expired IoT Credentaials for ${serialNumber}, fetching them`);
            }
            shadowClient.iotCredentials = await this.asyncGetDeviceIotCredentials(serialNumber);
        }
    }

    /**
     * Take the input and if not already an object, change to one with { value: in }
     *
     * @param {object | string | number} shadowState - Input value to check
     * @param {string} property - Name of property to check
     * @param {string | number | undefined} alternate - Alternate value to use if property is not already object
     */
    checkIsValueObject(shadowState, property, alternate = undefined) {
        if (typeof shadowState[property] != 'object') {
            shadowState[property] = { value: typeof alternate != 'undefined' ? alternate : shadowState[property] };
        }
    }

    /**
     * Get shadow reported state
     *
     * @param {string} serialNumber - Device serial number
     * @returns {Promise<object>} - Reported state
     */
    async asyncGetShadowReportedState(serialNumber) {
        await this.checkShadowClient(serialNumber);
        const shadowState = await this.shadowClients[serialNumber]?.asyncGetShadowReportedState();

        // Massage old states (ie. from Genie) to look like new (ie. from M9)

        this.checkIsValueObject(shadowState, 'online');
        this.checkIsValueObject(shadowState, 'mode', shadowState.robot_sta?.value);
        this.checkIsValueObject(shadowState, 'elec');
        this.checkIsValueObject(shadowState, 'mowing_area', shadowState.mowing_area_new?.value);
        this.checkIsValueObject(shadowState, 'mowing_time', shadowState.mowing_time_new?.value);

        if (typeof shadowState.map == 'undefined') {
            shadowState.map = {
                map_area: {
                    value: shadowState.map_area,
                },
                // Force strings
                area_id: `${shadowState.area_time}`,
                plan_id: `${shadowState.appointment_time}`,
            };
        }

        if (typeof shadowState.device_config == 'undefined') {
            shadowState.device_config = {
                pobctl_switch: shadowState.pobctl?.switch,
                pobctl_level: shadowState.pobctl?.level,
                rain_switch: shadowState.rain_switch,
                rain_continue_time: shadowState.rain_continue_time,
                volume: shadowState.volume,
            };
        }

        if (typeof shadowState.net_state == 'undefined') {
            shadowState.net_state = {
                '4g_state': shadowState['4g_state'],
                wifi_state: shadowState.wifi_state,
            };
        }

        return shadowState;
    }

    /**
     * Send service command
     *
     * @param {string} serialNumber - Device serial number
     * @param {string} cmd - Command
     * @param {unknown} data - ommand data
     * @returns {Promise<void>}
     */
    async asyncSendServiceCommand(serialNumber, cmd, data) {
        await this.checkShadowClient(serialNumber);
        return await this.shadowClients[serialNumber]?.asyncPublishServiceCommand({ cmd, data });
    }
}

/**
 * Client for Anthbot AWS IoT shadow endpoint
 */
class AnthbotShadowApiClient {
    /**
     * @param {object} options - Configuration options
     */
    constructor(options) {
        this._serialNumber = options.serialNumber;
        this._regionName = typeof options.regionName === 'string' && options.regionName ? options.regionName : null;
        this._iotEndpoint = AnthbotShadowApiClient._normalizeEndpoint(options.iotEndpoint);
        this._iotCredentials = null;
        this.verboseLogger = options.verboseLogger;
        this.fetch = options.fetch;

        const endpointRegion = AnthbotShadowApiClient._guessRegionFromEndpoint(this._iotEndpoint);
        if (this._regionName && endpointRegion && this._regionName !== endpointRegion) {
            if (this.verboseLogger) {
                this.verboseLogger(
                    `Anthbot region mismatch for ${options.serialNumber}: api region=${this._regionName} endpoint region=${endpointRegion} endpoint=${this._iotEndpoint}; endpoint region will be used for signing`,
                );
            }
        }
    }

    static _normalizeEndpoint(iotEndpoint) {
        if (typeof iotEndpoint !== 'string' || !iotEndpoint) {
            return DEFAULT_IOT_ENDPOINT;
        }
        let endpoint = iotEndpoint.trim();
        endpoint = endpoint.replace(/^https?:\/\//i, '');
        endpoint = endpoint.replace(/\/$/, '');
        return endpoint || DEFAULT_IOT_ENDPOINT;
    }

    static _guessRegionFromEndpoint(iotEndpoint) {
        if (!iotEndpoint.includes('.iot.')) {
            return null;
        }
        const rightSide = iotEndpoint.split('.iot.', 2)[1];
        const region = rightSide.split('.', 1)[0];
        return region || null;
    }

    static guessRegionFromEndpoint(iotEndpoint) {
        return AnthbotShadowApiClient._guessRegionFromEndpoint(iotEndpoint);
    }

    set iotCredentials(iotCredentals) {
        this._iotCredentials = iotCredentals;
    }

    iotCredentialsExpired() {
        return (
            !this._iotCredentials ||
            this._iotCredentials.expiresAt === null ||
            this._iotCredentials.expiresAt - Date.now() <= 60000
        );
    }

    get serialNumber() {
        return this._serialNumber;
    }

    get iotEndpoint() {
        return this._iotEndpoint;
    }

    get signingRegion() {
        const endpointRegion = AnthbotShadowApiClient._guessRegionFromEndpoint(this._iotEndpoint);
        if (endpointRegion) {
            return endpointRegion;
        }
        return this._regionName || DEFAULT_IOT_REGION;
    }

    _accessKeyId() {
        if (this._iotCredentials?.accessKeyId) {
            return this._iotCredentials.accessKeyId;
        }
        if (this._iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_ACCESS_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith('cn')) {
            return AWS_ACCESS_KEY_CN;
        }
        return AWS_ACCESS_KEY_DEFAULT;
    }

    _secretAccessKey() {
        if (this._iotCredentials?.secretAccessKey) {
            return this._iotCredentials.secretAccessKey;
        }
        if (this._iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_SECRET_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith('cn')) {
            return AWS_SECRET_KEY_CN;
        }
        return AWS_SECRET_KEY_DEFAULT;
    }

    _sessionToken() {
        return this._iotCredentials?.sessionToken;
    }

    static _sign(key, msg) {
        if (typeof key === 'string') {
            key = Buffer.from(key, 'utf-8');
        }
        return crypto.createHmac('sha256', key).update(msg).digest();
    }

    _signingKey(dateStamp) {
        const service = 'iotdata';
        const kDate = AnthbotShadowApiClient._sign(`AWS4${this._secretAccessKey()}`, dateStamp);
        const kRegion = AnthbotShadowApiClient._sign(kDate, this.signingRegion);
        const kService = AnthbotShadowApiClient._sign(kRegion, service);
        return AnthbotShadowApiClient._sign(kService, 'aws4_request');
    }

    _buildAuthorization(amzDate, dateStamp, canonicalRequest) {
        const algorithm = 'AWS4-HMAC-SHA256';
        const signedHeaders = AnthbotShadowApiClient._signedHeadersFromRequest(canonicalRequest);
        const credentialScope = `${dateStamp}/${this.signingRegion}/iotdata/aws4_request`;
        const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

        const signature = crypto.createHmac('sha256', this._signingKey(dateStamp)).update(stringToSign).digest('hex');

        return `${algorithm} Credential=${this._accessKeyId()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    }

    static _normalizeHeaderValue(value) {
        return value.trim().split(/\s+/).join(' ');
    }

    static _canonicalHeaders(headers) {
        const lowered = {};
        for (const [key, value] of Object.entries(headers)) {
            lowered[key.toLowerCase()] = AnthbotShadowApiClient._normalizeHeaderValue(value);
        }

        const orderedKeys = Object.keys(lowered).sort();
        let canonical = '';
        for (const key of orderedKeys) {
            canonical += `${key}:${lowered[key]}\n`;
        }

        const signedHeaders = orderedKeys.join(';');
        return [canonical, signedHeaders];
    }

    static _signedHeadersFromRequest(canonicalRequest) {
        const parts = canonicalRequest.split('\n');
        if (parts.length < 6) {
            return 'host;x-amz-content-sha256;x-amz-date';
        }
        return parts[parts.length - 2];
    }

    static _canonicalUriForSigv4(requestUri) {
        /**
         * Build SigV4 canonical URI.
         * AWS canonicalization requires encoding '%' as '%25', so an already
         * encoded request path (for example '/topics/%24aws%2F...') must be
         * double-encoded only for signing.
         */
        const encoded = [];
        const buffer = Buffer.from(requestUri, 'utf-8');

        for (const byte of buffer) {
            // 0-9: 0x30-0x39, A-Z: 0x41-0x5A, a-z: 0x61-0x7A, - . _ ~ /
            if (
                (byte >= 0x30 && byte <= 0x39) ||
                (byte >= 0x41 && byte <= 0x5a) ||
                (byte >= 0x61 && byte <= 0x7a) ||
                [45, 46, 95, 126, 47].includes(byte) // - . _ ~ /
            ) {
                encoded.push(String.fromCharCode(byte));
            } else {
                encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`);
            }
        }

        return encoded.join('');
    }

    async asyncGetShadowReportedState() {
        const requestUri = `/things/${this._encodePathComponent(this._serialNumber)}/shadow`;
        const canonicalUri = AnthbotShadowApiClient._canonicalUriForSigv4(requestUri);
        const canonicalQuery = `name=${this._encodePathComponent('property')}`;
        const payloadHash = crypto.createHash('sha256').update('').digest('hex');

        const now = new Date();
        const amzDate = now
            .toISOString()
            .replace(/[:-]/g, '')
            .replace(/\.\d{3}/, '');
        const dateStamp = amzDate.substring(0, 8);

        const signedHeaderValues = {
            host: this._iotEndpoint,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'x-amz-security-token': this._sessionToken(),
        };

        const [canonicalHeaders, signedHeaders] = AnthbotShadowApiClient._canonicalHeaders(signedHeaderValues);

        const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

        const authorization = this._buildAuthorization(amzDate, dateStamp, canonicalRequest);

        const url = `https://${this._iotEndpoint}${requestUri}?${canonicalQuery}`;
        const headers = {
            Accept: '*/*',
            Host: this._iotEndpoint,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
            'x-amz-security-token': this._sessionToken(),
            Authorization: authorization,
            'User-Agent': CLIENT_USER_AGENT,
        };

        const response = await this.fetch(url, {
            method: 'GET',
            headers,
        });

        if (response.status !== 200) {
            const body = await response.text();
            throw new Error(`Shadow request failed (${response.status}): ${body.slice(0, 300)}`);
        }

        let payload;
        try {
            // eslint-disable-next-line jsdoc/check-tag-names
            payload = /** @type {object | null} */ (await response.json());
        } catch {
            throw new Error('Invalid JSON response from shadow request');
        }

        if (typeof payload !== 'object' || payload === null) {
            throw new Error('Invalid response payload type');
        }

        const state = payload.state;
        const reported = typeof state === 'object' && state !== null ? state.reported : null;
        if (typeof reported !== 'object' || reported === null) {
            throw new Error('Missing state.reported in response');
        }

        return reported;
    }

    /**
     * Encode path component for AWS SigV4
     *
     * @param {string} component - Component to encode
     * @returns {string} - Encoded component
     */
    _encodePathComponent(component) {
        return encodeURIComponent(component).replace(/[!'()*]/g, ch => {
            return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
        });
    }

    async asyncPublishServiceCommand({ cmd, data }) {
        const body = { state: { desired: { cmd, data } } };

        const topic = `$aws/things/${this._serialNumber}/shadow/name/service/update`;
        const requestUriEncoded = `/topics/${this._encodePathComponent(topic)}`;
        const requestUriRaw = `/topics/${topic}`;

        // Different AWS clients canonicalize the URI slightly differently.
        // Try the app-observed mode first, then fall back to alternatives.
        const attempts = [
            // 1) SDK headers + encoded URI + app-style canonical URI (trace match)
            [requestUriEncoded, true, null, true],
            // 2) SDK headers + encoded URI + raw canonical URI
            [requestUriEncoded, true, requestUriEncoded, true],
            // 3) SDK headers + encoded URI + app-style canonical URI, no signed content-length
            [requestUriEncoded, true, null, false],
            // 4) LdMower headers + encoded URI + app-style canonical URI
            [requestUriEncoded, false, null, true],
            // 5) Raw topic path, SDK headers, app-style canonical URI
            [requestUriRaw, true, null, true],
            // 6) Raw topic path, SDK headers, raw canonical URI
            [requestUriRaw, true, requestUriRaw, true],
            // 7) Raw topic path, LdMower headers, app-style canonical URI
            [requestUriRaw, false, null, true],
        ];

        let lastStatus = 0;
        let lastBody = '';
        let lastHeaders = {};

        for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
            const [requestUri, includeSdkHeaders, canonicalUriOverride, signContentLength] = attempts[attemptIndex];

            const [status, bodyText, payload, responseHeaders] = await this._asyncSignedPost({
                requestUri,
                canonicalQuery: '',
                body,
                includeSdkHeaders,
                canonicalUriOverride,
                signContentLength,
            });

            if (status === 200 && typeof payload === 'object' && payload !== null) {
                if (attemptIndex > 0 && this.verboseLogger) {
                    this.verboseLogger(`Anthbot command publish recovered after fallback`);
                }
                // Response should contain { message: "OK" }
                if (payload.message !== 'OK') {
                    if (this.verboseLogger) {
                        this.verboseLogger(`payload.message !== 'OK' even with status === 200`);
                    }
                } else {
                    // Everything is good
                    return;
                }
            }

            lastStatus = status;
            lastBody = bodyText;
            lastHeaders = responseHeaders;

            if (status !== 403) {
                break;
            }

            if (this.verboseLogger) {
                this.verboseLogger(`Anthbot command publish attempt failed (${status})`);
            }
        }

        throw new Error(
            `Command '${cmd}' failed (${lastStatus}) at endpoint '${this._iotEndpoint}' ` +
                `(region '${this.signingRegion}', errortype '${lastHeaders['x-amzn-errortype']}', ` +
                `requestid '${lastHeaders['x-amzn-requestid'] || lastHeaders['x-amzn-request-id']}'): ` +
                `${lastBody.slice(0, 300)}`,
        );
    }

    /**
     * @param {{requestUri: string | boolean | null, canonicalQuery: string, body: object, includeSdkHeaders: string | boolean | null, canonicalUriOverride?: string | boolean | null, signContentLength?: string | boolean | null}} options - Request options
     */
    async _asyncSignedPost({
        requestUri,
        canonicalQuery,
        body,
        includeSdkHeaders,
        canonicalUriOverride = null,
        signContentLength = true,
    }) {
        const payloadBytes = Buffer.from(JSON.stringify(body).replace(/\s/g, ''), 'utf-8');
        const payloadHash = crypto.createHash('sha256').update(payloadBytes).digest('hex');

        const now = new Date();
        const amzDate = now
            .toISOString()
            .replace(/[:-]/g, '')
            .replace(/\.\d{3}/, '');
        const dateStamp = amzDate.substring(0, 8);

        const signedHeaderValues = {
            host: this._iotEndpoint,
            'content-type': 'application/octet-stream',
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'x-amz-security-token': this._sessionToken(),
        };

        const headers = {
            Accept: '*/*',
            Host: this._iotEndpoint,
            'Content-Type': 'application/octet-stream',
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'x-amz-security-token': this._sessionToken(),
        };

        if (signContentLength) {
            signedHeaderValues['content-length'] = String(payloadBytes.length);
            headers['Content-Length'] = String(payloadBytes.length);
        }

        if (includeSdkHeaders) {
            const invocationId = crypto.randomUUID();
            signedHeaderValues['amz-sdk-invocation-id'] = invocationId;
            signedHeaderValues['amz-sdk-request'] = 'attempt=1; max=3';
            signedHeaderValues['x-amz-user-agent'] = 'aws-sdk-js/3.846.0';
            headers['amz-sdk-invocation-id'] = invocationId;
            headers['amz-sdk-request'] = 'attempt=1; max=3';
            headers['x-amz-user-agent'] = 'aws-sdk-js/3.846.0';
            headers['User-Agent'] =
                'aws-sdk-js/3.846.0 ua/2.1 os/other lang/js md/rn api/iot-data-plane#3.846.0 m/N,E,e';
        } else {
            headers['User-Agent'] = CLIENT_USER_AGENT;
        }

        const [canonicalHeaders, signedHeaders] = AnthbotShadowApiClient._canonicalHeaders(signedHeaderValues);

        const canonicalUri =
            canonicalUriOverride !== null
                ? canonicalUriOverride
                : AnthbotShadowApiClient._canonicalUriForSigv4(requestUri);

        const canonicalRequest = `POST\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

        headers['Authorization'] = this._buildAuthorization(amzDate, dateStamp, canonicalRequest);

        let url = `https://${this._iotEndpoint}${requestUri}`;
        if (canonicalQuery) {
            url = `${url}?${canonicalQuery}`;
        }

        const response = await this.fetch(url, {
            method: 'POST',
            headers,
            body,
        });

        const bodyText = await response.text();
        let payload = null;
        try {
            const parsed = JSON.parse(bodyText);
            if (typeof parsed === 'object' && parsed !== null) {
                payload = parsed;
            }
        } catch {
            // Invalid JSON, leave payload as null
        }

        const responseHeaders = {
            'x-amzn-errortype': response.headers.get('x-amzn-errortype') || '',
            'x-amzn-requestid': response.headers.get('x-amzn-requestid') || '',
            'x-amzn-request-id': response.headers.get('x-amzn-request-id') || '',
            date: response.headers.get('date') || '',
        };

        return [response.status, bodyText, payload, responseHeaders];
    }
}

// Exports
module.exports = {
    AnthbotCloudApiClient,
};
