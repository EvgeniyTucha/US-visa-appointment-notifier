const puppeteer = require('puppeteer-extra');
const {parseISO, compareAsc, isBefore, format} = require('date-fns')
require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const dateFormat = 'yyyy-MM-dd';

const {delay, sendEmail, logStep, debug} = require('./utils');
const {
    siteInfo,
    loginCred,
    IS_PROD,
    NEXT_SCHEDULE_POLL_MIN,
    MAX_NUMBER_OF_POLL,
    NOTIFY_ON_DATE_BEFORE,
    EARLIEST_DATE_SHIFT
} = require('./config');
const {th} = require("date-fns/locale");
const config = require("./config");

let maxTries = MAX_NUMBER_OF_POLL
const botToken = config.telegram.NOTIFY_TG_TOKEN;
const chatId = config.telegram.NOTIFY_TG_CHAT_ID;
const bot = new TelegramBot(botToken, {polling: true});

const login = async (page) => {
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

    return true;
}

const notifyMe = async (earliestDate, availableTimes) => {
    const formattedDate = format(earliestDate, dateFormat);
    logStep(`sending an email to schedule for ${formattedDate}. Available times are: ${availableTimes}`);
    await sendEmail({
        subject: `We found an earlier date ${formattedDate}`,
        text: `Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`
    })
}

const reschedule = async (page, earliestDate, availableTimes) => {
    const formattedDate = format(earliestDate, dateFormat);
    if (availableTimes[0] != null) {
        logStep(`Rescheduling for ${formattedDate} at ${availableTimes[0]}`);

        await page.goto(siteInfo.APPOINTMENTS_URL);

        await page.select('select#appointments_consulate_appointment_facility_id', siteInfo.FACILITY_ID);

        logStep('Rescheduling step #1 facility selected');

        const date = await page.waitForSelector("input#appointments_consulate_appointment_date");

        logStep('Rescheduling step #2 date selector');

        await date.evaluate((el) => el.click()); // Ensure interactive click
        await delayMs(1000);

        logStep('Rescheduling step #2.1 date selector clicked');

        const [year, month, day] = formattedDate.split('-');

        const zeroBasedMonth = parseInt(month, 10) - 1;

        const tdSelector = `td.undefined[data-handler="selectDay"][data-event="click"][data-month="${zeroBasedMonth}"][data-year="${year}"]`;
        const linkSelector = 'a.ui-state-default';
        const nextButtonSelector = 'a.ui-datepicker-next[data-handler="next"]';

        let isDateVisible = false;
        let attempts = 0;
        const maxAttempts = 24; // Adjust based on reasonable maximum clicks needed

        while (!isDateVisible && attempts < maxAttempts) {
            logStep(`Attempt ${attempts}: Checking for date visibility...`);
            isDateVisible = await page.evaluate((tdSelector) => {
                return !!document.querySelector(tdSelector);
            }, tdSelector);

            if (!isDateVisible) {
                logStep('Date not visible, clicking next...');
                await page.click(nextButtonSelector);
                await delayMs(1000);
                attempts++;
            }
        }
        if (!isDateVisible) {
            throw new Error(`Failed to find the desired date (${formattedDate}) after ${maxAttempts} attempts. Possible DOM structure issue.`);
        }

        // Click the link inside the <td> element once it is visible
        await page.evaluate((tdSelector, linkSelector) => {
            const tdElement = document.querySelector(tdSelector);
            if (tdElement) {
                const linkElement = tdElement.querySelector(linkSelector);
                if (linkElement) {
                    linkElement.click();
                } else {
                    throw new Error('Link element not found inside the specified <td>.');
                }
            } else {
                throw new Error('Specified <td> element not found.');
            }
        }, tdSelector, linkSelector);

        logStep('Rescheduling step #2.2 date selector clicked');

        await delayMs(500);

        const timeSelector = 'select#appointments_consulate_appointment_time';
        await page.waitForSelector(timeSelector);
        await page.select(timeSelector, availableTimes[0]);

        await delayMs(500);
        logStep('Rescheduling step #3 time clicked');

        const submitButtonSelector = 'input#appointments_submit';
        await page.waitForSelector(submitButtonSelector);
        await page.click(submitButtonSelector);

        await delayMs(500);

        logStep('Rescheduling step #4 submit button clicked');

        const confirmButtonSelector = 'div[data-confirm-footer] a.button.alert';

        // Wait for the Confirm button to be visible on the page
        await page.waitForSelector(confirmButtonSelector, {visible: true});
        await page.click(confirmButtonSelector);

        await sendTelegramNotification(`Booking for ${formattedDate} at ${availableTimes[0]} completed`);
        await sendTelegramScreenshot(page, `reschedule_finished_${formattedDate}`);
    }
}

const sendTelegramNotification = async (message) => {
    bot.sendMessage(chatId, message)
        .then(() => console.log('Notification sent!'))
        .catch((err) => console.error('Error sending notification:', err));
};

const sendTelegramScreenshot = async (page, fileName) => {
    const logName = `${fileName}.png`;
    await page.screenshot({ path:  logName});

    bot.sendPhoto(chatId, logName)
        .then(() => console.log('Screenshot sent!'))
        .catch((err) => console.error('Error sending screenshot:', err));
};

const notifyMeViaTelegram = async (earliestDate, availableTimes) => {
    if (config.telegram.NOTIFY_TG_TOKEN === '' || config.telegram.NOTIFY_TG_CHAT_ID === '') {
        logStep('Telegram token or chat id is not provided, skipping telegram notification');
        return;
    }
    const formattedDate = format(earliestDate, dateFormat);
    logStep(`sending an TG notification to schedule for ${formattedDate}. Available times are: ${availableTimes}`);

    await sendTelegramNotification(`Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`);
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

    // console.log("Parsed Date:", parsedDate.toISOString()); // Outputs date in ISO 8601 format

    // Subtract 2 days
    const twoDaysInMilliseconds = 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
    const newDate = new Date(parsedDate.getTime() - twoDaysInMilliseconds);
    logStep(`Booked date -2 days to compare: ${newDate}`);
    return newDate;
}

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

        await login(page);

        const currentDate = await getMainPageDetails(page);

        const checkForScheduleDate = await checkForSchedules(page);

        if (checkForScheduleDate) {
            const earliestDate = findEarliestDate([currentDate, checkForScheduleDate]);

            let earliestDateStr = format(earliestDate, dateFormat);
            let availableTimes = await checkForAvailableTimes(page, earliestDateStr);

            if (earliestDate && availableTimes) {
                logStep(`Earliest date found is ${earliestDateStr}, available times are ${availableTimes}`);

                let shiftDate = addDays(now, EARLIEST_DATE_SHIFT);
                if (isBefore(earliestDate, shiftDate)) {
                    logStep(`Earliest date ${earliestDateStr} is before minimum allowed date ${shiftDate}`);
                    throw new Error(`Earliest date ${earliestDateStr} is before minimum allowed date ${shiftDate}`);
                }

                let diff = Math.round((earliestDate - now) / (1000 * 60 * 60 * 24))

                const row = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString() + "," + earliestDateStr + "," + diff + "," + availableTimes + "\n"

                fs.appendFile('./dates.csv', row, err => {
                    if (err) {
                        console.error(err);
                    }
                });
                if (isBefore(earliestDate, parseISO(NOTIFY_ON_DATE_BEFORE))) {
                    await notifyMeViaTelegram(earliestDate, availableTimes);
                    await reschedule(page, earliestDate, availableTimes);
                }
            }
        }
    } catch (err) {
        console.error(err);
        await sendTelegramNotification(`Huston we have a problem: ${err}`);
        const formattedDate = format(now, dateFormat);
        await sendTelegramScreenshot(page, `error_on_date_${formattedDate}`);
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
    }
})();

function findEarliestDate(dates) {
    return dates.reduce((earliest, current) =>
        current.getTime() < earliest.getTime() ? current : earliest
    );
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

async function delayMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}