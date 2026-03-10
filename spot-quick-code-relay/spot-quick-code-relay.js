/**
 * Spot Price Relay Script for Shelly Devices
 * 
 * This script will use QuickCode feature of spot-hinta.fi for determining if relays should be turned on or off.
 * 
 * Quick codes: https://spot-hinta.fi/Pikakoodit/
 * 
 * Special thanks to https://spot-hinta.fi for providing the API that makes this script possible. Consider supporting them!
 */

const relayConfigs = [
    {
        quickCode: 142,
        isInverse: false
    }, {
        quickCode: 142,
        isInverse: true
    }
];

const quickCodeApi = "https://api.spot-hinta.fi/QuickCode";
const retryDelaySeconds = 60;
const maxConsecutiveFailures = 5;
let downloadErrorCount = 0;

function debug(title, message) {
    Shelly.emitEvent("Notification", {
        title: title,
        message: message,
        timestamp: Date.now()
    });
}

function sendNotification(title, message) {
    debug(title, message);
    Shelly.call(
        "NotifyEvent",
        {
            ts: Math.floor(Date.now() / 1000),
            events: [{
                component: "sys",
                event: "custom_notification",
                ts: Math.floor(Date.now() / 1000),
                title: title,
                message: message
            }]
        },
        function (response, errorCode, errorMessage) {
            if (errorCode !== 0) {
                debug("Failed to send notification: " + errorMessage);
            } else {
                debug("Notification sent: " + title);
            }
        }
    );
}

function downloadQuickCodeStatus(quickCode) {
    debug("Downloading quick code status from API from " + quickCodeApi + "/" + quickCode);
    Shelly.call(
        "HTTP.GET",
        {
            url: quickCodeApi + "/" + quickCode,
            timeout: 10,
            ssl_ca: "*"
        },
        function (response, errorCode, errorMessage) {
            debug("Quick code status download finished");
            if (errorCode !== 0) {
                debug("HTTP.GET failed with error " + errorCode + " " + errorMessage);
                handleDownloadError("HTTP-kutsu epäonnistui: " + errorMessage);
                return;
            }

            if (response.code !== 200 && response.code !== 400) {
                if (response.code === 429) {
                    handleDownloadError("Liian monta rajapintakutsua (429)");
                } else {
                    handleDownloadError("Rajapinta palautti statuksen " + response.code);
                }
                return;
            }

            // Treat 200 (enabled) and 400 (quick code not active) as successful API responses
            downloadErrorCount = 0;
            debug("Quick code " + quickCode + " status downloaded successfully: " + response.code);
            controlRelays(quickCode, response.code === 200);
        }
    );
}

function downloadQuickCodeStatuses() {
    const relayMap = {}
    for (const config of relayConfigs) {
        relayMap[config.quickCode] = true;
    }
    const quickCodes = Object.keys(relayMap);
    debug("Downloading statuses for quick codes: " + quickCodes.join(", "));
    if (quickCodes.length === 0) {
        debug("No quick codes configured, skipping and stopping script.");
        return;
    }

    for (const quickCode of quickCodes) {
        downloadQuickCodeStatus(parseInt(quickCode));
    }
    scheduleNextDownload();
}

function handleDownloadError(errorMessage) {
    downloadErrorCount++;
    debug("Download error #" + downloadErrorCount + ": " + errorMessage);

    if (downloadErrorCount === 3) {
        sendNotification(
            "Spot-hintojen lataus epäonnistui",
            "Lataus epäonnistui kolmannen kerran putkeen. Virheviesti: " + errorMessage
        );
    } else if (downloadErrorCount === maxConsecutiveFailures) {
        sendNotification(
            "Spot-hintojen lataus pysäytetty",
            maxConsecutiveFailures + " peräkkäistä latausvirhettä! Asetetaan releet turvalliseen tilaan. Viimeisin virhe: " + errorMessage
        );
        setSafeMode();
    }

    if (downloadErrorCount >= maxConsecutiveFailures) {
        debug("Critical: " + maxConsecutiveFailures + " consecutive download failures! Stopping retries.");
        return;
    }

    const retryDelay = retryDelaySeconds * 1000 * Math.min(downloadErrorCount, 5);
    debug("Scheduling retry in " + (retryDelay / 1000) + " seconds");
    Timer.set(retryDelay, false, downloadQuickCodeStatuses);
}

function scheduleNextDownload() {
    const now = new Date();
    const fifteenMinutesMs = 15 * 60 * 1000;
    const currentMs = now.getTime();

    const msSinceHour = currentMs % (60 * 60 * 1000);
    const delayMs = fifteenMinutesMs - (msSinceHour % fifteenMinutesMs) + 2000; // Add 2 seconds buffer

    debug("Scheduled next quick code status download for + " + delayMs / 1000 / 60 + " minutes");
    Timer.set(delayMs, false, downloadQuickCodeStatuses);
}

function controlRelays(quickCode, isEnabled) {
    debug("Setting relay state for quickCode " + quickCode + ": " + isEnabled);
    for (let i = 0; i < relayConfigs.length; i++) {
        const config = relayConfigs[i];
        if (config.quickCode !== quickCode) {
            debug("Quickcode doesn't match: " + config.quickCode + " != " + quickCode);
            continue;
        }
        const targetState = config.isInverse ? !isEnabled : isEnabled;
        debug("Relay " + i + " state: " + (targetState ? "ENABLED" : "DISABLED") + " for quick code " + quickCode);

        Shelly.call(
            "Switch.set",
            {
                id: i,
                on: targetState
            },
            function (response, errorCode, errorMessage, relayIndex) {
                if (errorCode !== 0) {
                    debug("Failed to set relay " + relayIndex + " state: " + errorMessage);
                    sendNotification(
                        "Releen hallintavirhe",
                        "Releen " + relayIndex + " tilan asettaminen epäonnistui: " + errorMessage
                    );
                } else {
                    debug("Relay " + relayIndex + " state set successfully to " + (targetState ? "ON" : "OFF"));
                }
            },
            i
        );
    }
}

function setSafeMode() {
    debug("Setting relays to safe mode (high price assumption)");
    for (const config of relayConfigs) {
        controlRelays(config.quickCode, false);
    }
}

sendNotification("Laite käynnistyy", "Spot-rele käynnistyy.");

downloadQuickCodeStatuses();

