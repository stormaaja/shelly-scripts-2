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

const printBuffer = [];

function flushPrintBuffer() {
    if (printBuffer.length > 0) {
        const messages = printBuffer.join("\n");
        printBuffer.length = 0;
        print(messages);
    }
}

function printb(msg) {
    printBuffer.push(msg);
    if (printBuffer.length >= 10) {
        flushPrintBuffer();
    }
}

function sendNotification(title, message) {
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
                printb("Failed to send notification: " + errorMessage);
            } else {
                printb("Notification sent: " + title);
            }
        }
    );
}

function downloadQuickCodeStatus(quickCode) {
    printb("Downloading quick code status from API from " + quickCodeApi + "/" + quickCode);
    Shelly.call(
        "HTTP.GET",
        {
            url: quickCodeApi + "/" + quickCode,
            timeout: 10,
            ssl_ca: "*"
        },
        function (response, errorCode, errorMessage) {
            printb("Quick code status download finished");
            if (errorCode !== 0) {
                printb("HTTP.GET failed with error " + errorCode + " " + errorMessage);
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
            printb("Quick code " + quickCode + " status downloaded successfully: " + response.code);
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
    printb("Downloading statuses for quick codes: " + quickCodes.join(", "));
    if (quickCodes.length === 0) {
        printb("No quick codes configured, skipping and stopping script.");
        return;
    }

    for (const quickCode of quickCodes) {
        downloadQuickCodeStatus(quickCode);
    }
    scheduleNextDownload();
}

function handleDownloadError(errorMessage) {
    downloadErrorCount++;
    printb("Download error #" + downloadErrorCount + ": " + errorMessage);

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
        printb("Critical: " + maxConsecutiveFailures + " consecutive download failures! Stopping retries.");
        return;
    }

    const retryDelay = retryDelaySeconds * 1000 * Math.min(downloadErrorCount, 5);
    printb("Scheduling retry in " + (retryDelay / 1000) + " seconds");
    Timer.set(retryDelay, false, downloadQuickCodeStatuses);
}

function scheduleNextDownload() {
    const now = new Date();
    const fifteenMinutesMs = 15 * 60 * 1000;
    const currentMs = now.getTime();

    const msSinceHour = currentMs % (60 * 60 * 1000);
    const delayMs = fifteenMinutesMs - (msSinceHour % fifteenMinutesMs) + 2000; // Add 2 seconds buffer

    printb("Scheduled next quick code status download for + " + delayMs / 1000 / 60 + " minutes");
    Timer.set(delayMs, false, downloadQuickCodeStatuses);
}

function controlRelays(quickCode, isEnabled) {
    for (let i = 0; i < relayConfigs.length; i++) {
        const config = relayConfigs[i];
        if (config.quickCode !== quickCode) {
            continue;
        }
        const targetState = config.isInverse ? !isEnabled : isEnabled;
        printb("Relay " + i + " state: " + (targetState ? "ENABLED" : "DISABLED") + " for quick code " + quickCode);

        Shelly.call(
            "Switch.set",
            {
                id: i,
                on: targetState
            },
            function (response, errorCode, errorMessage, relayIndex) {
                if (errorCode !== 0) {
                    printb("Failed to set relay " + relayIndex + " state: " + errorMessage);
                    sendNotification(
                        "Releen hallintavirhe",
                        "Releen " + relayIndex + " tilan asettaminen epäonnistui: " + errorMessage
                    );
                } else {
                    printb("Relay " + relayIndex + " state set successfully to " + (targetState ? "ON" : "OFF"));
                }
            },
            i
        );
    }
}

function setSafeMode() {
    printb("Setting relays to safe mode (high price assumption)");
    for (const config of relayConfigs) {
        controlRelays(config.quickCode, false);
    }
}

sendNotification("Laite käynnistyy", "Spot-rele käynnistyy.");

Timer.set(5000, true, function () {
    flushPrintBuffer();
})

downloadQuickCodeStatuses();

