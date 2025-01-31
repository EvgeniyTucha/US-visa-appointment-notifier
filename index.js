const puppeteer = require('puppeteer-extra');
const {parseISO, compareAsc, isBefore, format, isEqual} = require('date-fns')
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const dateFormat = 'yyyy-MM-dd';
const cron = require('node-cron');
const fs = require('fs');

const {delay, logStep, debug} = require('./utils');
const {
    siteInfo,
    loginCred,
    IS_PROD,
    NEXT_SCHEDULE_POLL_MIN,
    MAX_NUMBER_OF_POLL,
    NOTIFY_ON_DATE_BEFORE,
    EARLIEST_DATE_SHIFT
} = require('./config');
const config = require("./config");
const {da} = require("date-fns/locale");

let maxTries = MAX_NUMBER_OF_POLL
const botToken = config.telegram.NOTIFY_TG_TOKEN;
const chatId = config.telegram.NOTIFY_TG_CHAT_ID;

const loginAndFetchActiveBookingDate = async (page) => {
    logStep('logging in');

    await page.goto(siteInfo.LOGIN_URL);

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

    const form = await page.$("form#sign_in_form");
    if (!form) {
        throw new Error("Login form not found on the page");
    }

    const email = await form.$('input[name="user[email]"]');
    const password = await form.$('input[name="user[password]"]');
    const privacyTerms = await form.$('input[name="policy_confirmed"]');
    const signInButton = await form.$('input[name="commit"]');

    if (!email || !password || !privacyTerms || !signInButton) {
        throw new Error("One or more form fields not found");
    }

    await email.type(loginCred.EMAIL);
    await password.type(loginCred.PASSWORD);
    await privacyTerms.click();
    await signInButton.click();

    await page.waitForNavigation();
    const countryCode = siteInfo.COUNTRY_CODE;
    const scheduleId = siteInfo.SCHEDULE_ID;
    const bodyText = await page.evaluate((countryCode, scheduleId) => {
        const appointmentElements = document.querySelectorAll('.consular-appt'); // Select all elements with class "consular-appt"

        for (const element of appointmentElements) {
            const linkElement = element.querySelector(`a[href*="/${countryCode}/niv/schedule/${scheduleId}"]`);
            if (linkElement) {
                // Match the date within the current `.consular-appt` element
                const dateText = element.innerText.match(/\d{1,2} \w+, \d{4}, \d{2}:\d{2}/);
                return dateText ? dateText[0].trim() : null; // Return the date if found
            }
        }
        return null;
    }, countryCode, scheduleId);
    // Vancouver is in GMT-7 for local time
    const parsedDate = new Date(bodyText + " GMT-7");
    logStep(`Parsed booked date: ${parsedDate} from profile`);

    // Subtract 2 days
    const twoDaysInMilliseconds = 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
    const newDate = new Date(parsedDate.getTime() - twoDaysInMilliseconds);
    logStep(`Booked date -2 days to compare: ${newDate}`);
    return newDate;
}

const getMainPageDetails = async (page) => {
    logStep('checking main page details for current booking date');
    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });

    await page.goto(siteInfo.BASE_DATA_URL);

    const bodyText = await page.evaluate(() => {
        return document.querySelector('.consular-appt').innerText
    });

    const match = bodyText.match(/(\d{1,2} \w+, \d{4}, \d{2}:\d{2})/);

    // Vancouver is in GMT-7 for local time
    const parsedDate = new Date(match[1] + " GMT-7");
    logStep(`Parsed booked date: ${parsedDate} from profile`);

    return parsedDate;
}

async function reschedule(page, earliestDateAvailable, appointment_time, facility_id) {
    const now = new Date();
    const formattedNowDate = format(now, dateFormat);
    const dateAsStr = format(earliestDateAvailable, dateFormat);
    logStep(`Starting Alt Reschedule (${dateAsStr})`);
    try {
        await page.goto(siteInfo.APPOINTMENTS_URL);

        const formData = {
            "utf8": "✓",
            "authenticity_token": await page.$eval('input[name="authenticity_token"]', el => el.value),
            "confirmed_limit_message": await page.$eval('input[name="confirmed_limit_message"]', el => el.value),
            "use_consulate_appointment_capacity": await page.$eval('input[name="use_consulate_appointment_capacity"]', el => el.value),
            "appointments[consulate_appointment][facility_id]": facility_id,
            "appointments[consulate_appointment][date]": dateAsStr,
            "appointments[consulate_appointment][time]": appointment_time,
        };

        const response = await page.evaluate(async (formData) => {
            const form = document.createElement('form');
            form.method = 'POST';

            for (const key in formData) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = key;
                input.value = formData[key];
                form.appendChild(input);
            }

            document.body.appendChild(form);
            return fetch(form.action, {
                method: 'POST',
                body: new FormData(form),
            });
        }, formData);

        const bookedDate = await getMainPageDetails(page);
        const bookedDateStr = format(bookedDate, dateFormat)
        logStep(`Booked date: ${bookedDateStr} vs earliest date: ${dateAsStr}`)
        if (bookedDateStr === dateAsStr) {
            const msg = `Rescheduled Successfully! ${dateAsStr} ${appointment_time}`;
            await sendTelegramNotification(msg);
            await sendTelegramScreenshot(page, `reschedule_successful_${formattedNowDate}`);
        } else {
            const msg = `Reschedule Failed. ${dateAsStr} ${appointment_time}. Status: ${response.status}`;
            await sendTelegramNotification(msg);
            await sendTelegramScreenshot(page, `reschedule_failed_${formattedNowDate}`);
        }
    } catch (error) {
        console.error('Error during reschedule:', error);
        await sendTelegramNotification(`Huston we have a problem during ALT rescheduling: ${err}`);
        await sendTelegramScreenshot(page, `error_alt_reschedule_on_date_${formattedNowDate}`);
    }
}

const sendTelegramNotification = async (message) => {
    const bot = new TelegramBot(botToken, {polling: false});
    bot.sendMessage(chatId, message)
        .then(() => console.log('Notification sent!'))
        .catch((err) => console.error('Error sending notification:', err));
};

const sendTelegramScreenshot = async (page, fileName) => {
    try {
        const logName = `${fileName}.png`;

        const dimensions = await page.evaluate(() => {
            return {
                width: document.documentElement.offsetWidth,
                height: document.documentElement.offsetHeight,
            };
        });

        if (dimensions.width > 0 && dimensions.height > 0) {
            await page.screenshot({path: logName, fullPage: true});
            const bot = new TelegramBot(botToken, {polling: false});
            bot.sendPhoto(chatId, logName)
                .then(() => console.log('Screenshot sent!'))
                .catch((err) => console.error('Error sending screenshot:', err));
        } else {
            logStep('The page has zero width or height.');
        }
    } catch (err) {
        const msg = `Error during taking screenshot: ${err}`;
        logStep(msg)
        await sendTelegramNotification(msg)
    }
};

const checkForSchedules = async (page) => {
    logStep('checking for schedules');
    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });
    await page.goto(siteInfo.APPOINTMENTS_JSON_URL);

    const bodyText = await page.evaluate(() => {
        return document.querySelector('body').innerText
    });

    const parsedBody = JSON.parse(bodyText);

    if (!Array.isArray(parsedBody)) {
        throw "Failed to parse dates, probably because you are not logged in";
    }

    const dates = parsedBody.map(item => parseISO(item.date));
    const [earliest] = dates.sort(compareAsc)
    logStep(`earliest available date found: ${earliest}`);
    return earliest;
}

const checkForAvailableTimes = async (page, earliestDateStr) => {
    logStep(`checking for available times on the ${earliestDateStr}`);

    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });

    const url = getAvailableTimesUrl(earliestDateStr);
    await page.goto(url);

    const bodyText = await page.evaluate(() => {
        return document.querySelector('body').innerText
    });

    const parsedBody = JSON.parse(bodyText);
    const availableTimes = parsedBody.available_times;
    if (availableTimes.length > 0 && availableTimes[0] == null) {
        logStep(`NO available times for the date : ${earliestDateStr} response : ${JSON.stringify(parsedBody)}`);
        return;
    }
    logStep(`available time for the date : ${earliestDateStr} is : ${availableTimes} :: response : ${JSON.stringify(parsedBody)}`);
    return availableTimes;
}

const process = async () => {
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const browser = await puppeteer.launch(!IS_PROD ? {headless: false} : {args: ['--no-sandbox', '--disable-setuid-sandbox']});

    logStep(`starting process with ${maxTries} tries left`);

    const now = new Date();
    const page = await browser.newPage();

    try {
        if (maxTries-- <= 0) {
            await sendTelegramNotification('Max retries reached. Please restart the process.');
            console.log('Reached Max tries')
            return
        }

        const activeAppointmentDate = await loginAndFetchActiveBookingDate(page);

        const earliestDateAvailable = await checkForSchedules(page);
        if (earliestDateAvailable) {
            let earliestDateStr = format(earliestDateAvailable, dateFormat);
            const row = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString() + "," + earliestDateStr + "\n"

            fs.appendFile('./dates.csv', row, err => {
                if (err) {
                    console.error(err);
                }
            });
            if (!isBefore(earliestDateAvailable, activeAppointmentDate)) {
                logStep(`Earliest date [${format(earliestDateAvailable, dateFormat)}] available to book is after already scheduled appointment on [${format(activeAppointmentDate, dateFormat)}]`)
            } else {
                let availableTimes = await checkForAvailableTimes(page, earliestDateStr);

                if (availableTimes) {
                    logStep(`Earliest date found is ${earliestDateStr}, available times are ${availableTimes}`);

                    let shiftDate = addDays(now, EARLIEST_DATE_SHIFT);
                    if (isBefore(earliestDateAvailable, shiftDate)) {
                        const msg = `Earliest date ${earliestDateStr} is before minimum allowed date ${shiftDate}`;
                        logStep(msg);
                        throw new Error(msg);
                    }

                    if (isBefore(earliestDateAvailable, parseISO(NOTIFY_ON_DATE_BEFORE))) {
                        await reschedule(page, earliestDateAvailable, availableTimes[0], siteInfo.FACILITY_ID);
                    }
                }
            }
        }
    } catch (err) {
        console.error(err);
        if (err.name !== 'TimeoutError') {
            await sendTelegramNotification(`Huston we have a problem: ${err}`);
        }
    }

    await browser.close();

    logStep(`Sleeping for ${NEXT_SCHEDULE_POLL_MIN} minutes`)

    await delay(NEXT_SCHEDULE_POLL_MIN)

    await process()
}

function getAvailableTimesUrl(availableDate) {
    return siteInfo.AVAILABLE_TIMES_URL + `?date=${availableDate}&appointments[expedite]=false`
}

(async () => {
    try {
        await process();
    } catch (err) {
        console.error(err);
        await sendTelegramNotification(`Huston we have a problem: ${err}. \n Script stopped`);
    }
})();

function addDays(theDate, days) {
    return new Date(theDate.getTime() + days * 24 * 60 * 60 * 1000);
}

async function getClosestDates() {
    try {
        const csvData = fs.readFileSync('./dates.csv', 'utf-8');
        const rows = csvData.trim().split('\n');
        const now = new Date();
        const yesterdayISO = new Date(now.getTime() - (24 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60000))
            .toISOString()
            .slice(0, 10);

        const dates = rows
            .map(row => {
                const [dateStr, returnDate] = row.split(',').map(item => item.trim());
                return {compareDate: new Date(dateStr), returnDate};
            })
            .filter(entry => entry.compareDate.toISOString().startsWith(yesterdayISO)); // Sort by the first column date

        if (dates) {
            const closestDates = Array.from(
                new Set(dates.map(entry => entry.returnDate))
            )
                .sort((a, b) => new Date(a) - new Date(b))
                .slice(0, 3);

            // Ensure closestDates always has 3 elements by padding with "N/A"
            while (closestDates.length < 3) {
                closestDates.push("N/A");
            }
            const message = 'Closest Dates found on ' + yesterdayISO + ': [ ' + closestDates + ' ]';
            console.log(message);
            await sendTelegramNotification(message);
        }
    } catch (error) {
        console.error('Error reading or processing CSV file:', error);
    }
}

// Schedule the function to run daily at 00:01 (1 minute past midnight)
cron.schedule('1 0 * * *', () => {
    logStep('Running scheduled task for daily closest dates');
    getClosestDates();
});