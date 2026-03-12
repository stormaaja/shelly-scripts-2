/**
 * Spot Price Relay Script for Shelly Devices
 *
 * Special thanks to https://spot-hinta.fi for providing the API that makes this script possible. Consider supporting them!
 */
const relayConfigs = [
    {
        limitPrice: 0.02,
        onCondition: "below"
    },
    {
        limitPrice: 0.02,
        onCondition: "above-or-equal"
    }
];

let downloadErrorCount = 0;

const spotPriceApi = "https://api.spot-hinta.fi/JustNow";
const retryDelaySeconds = 60;
const maxConsecutiveFailures = 5;

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

function downloadCurrentSpotPrice() {
    debug("Downloading current spot price from API...");

    Shelly.call(
        "HTTP.GET",
        {
            url: spotPriceApi,
            timeout: 10
        },
        function (response, errorCode, errorMessage) {
            if (errorCode !== 0) {
                handleDownloadError("HTTP-kutsu epäonnistui: " + errorMessage);
                return;
            }

            if (response.code !== 200) {
                if (response.code === 429) {
                    handleDownloadError("Liian monta rajapintakutsua (429)");
                } else {
                    handleDownloadError("Rajapinta palautti statuksen " + response.code);
                }
                return;
            }

            try {
                const data = JSON.parse(response.body);
                if (!data || typeof data.PriceWithTax === 'undefined') {
                    handleDownloadError("Virheellistä tai puutteellista dataa (verollinen hinta puuttuu)");
                    return;
                }

                const previousErrorCount = downloadErrorCount;
                const newPrice = data.PriceWithTax;
                const priceDate = data.DateTime;
                downloadErrorCount = 0;

                debug("Successfully downloaded current spot price: " + newPrice + " €/kWh at " + priceDate);

                if (previousErrorCount >= 3) {
                    sendNotification(
                        "Spot-hinta toimii taas",
                        "Hintojen lataus toimii taas " + previousErrorCount + ". yrityksen jälkeen ja kaikki on taas kunnossa."
                    );
                }

                controlRelays(newPrice);
                scheduleNextDownload();

            } catch (e) {
                handleDownloadError("Datan parsinta epäonnistui: " + e.message);
            }
        }
    );
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
    Timer.set(retryDelay, false, downloadCurrentSpotPrice);
}

function scheduleNextDownload() {
    const now = new Date();
    const fifteenMinutesMs = 15 * 60 * 1000;
    const currentMs = now.getTime();

    const msSinceHour = currentMs % (60 * 60 * 1000);
    const delayMs = fifteenMinutesMs - (msSinceHour % fifteenMinutesMs) + 2000; // Add 2 seconds buffer

    debug("Scheduled next spot price download for + " + delayMs / 1000 / 60 + " minutes");
    Timer.set(delayMs, false, downloadCurrentSpotPrice);
}

function setSafeMode() {
    debug("Setting relays to safe mode (high price assumption)");
    controlRelays(999.0);
}

function calculateRelayState(config, currentPrice) {
    if (currentPrice === null) {
        return false;
    }

    if (config.onCondition === "below") {
        return currentPrice < config.limitPrice;
    } else if (config.onCondition === "above-or-equal") {
        return currentPrice >= config.limitPrice;
    }

    return false;
}

function controlRelays(currentPrice) {
    if (currentPrice === null) {
        debug("No current spot price data available - skipping relay control");
        return;
    }

    debug("Current spot price: " + currentPrice + " €/kWh (with tax)");

    for (let i = 0; i < relayConfigs.length; i++) {
        const config = relayConfigs[i];
        const targetState = calculateRelayState(config, currentPrice);

        debug("Relay " + i + " - Limit: " + config.limitPrice + " €/kWh, Condition: " + config.onCondition + ", Target state: " + (targetState ? "ON" : "OFF"));

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

debug("Initializing spot price downloader...");
sendNotification("Laite käynnistyy", "Spot-hinta-rele käynnistyy.");
downloadCurrentSpotPrice();