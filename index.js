const puppeteer = require('puppeteer');
const {parseISO, compareAsc, isBefore, format} = require('date-fns')
require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');

const {delay, sendEmail, logStep, debug} = require('./utils');
const {
    siteInfo,
    loginCred,
    IS_PROD,
    NEXT_SCHEDULE_POLL_MIN,
    MAX_NUMBER_OF_POLL,
    NOTIFY_ON_DATE_BEFORE,
    SLEEP_HOUR,
    WAKEUP_HOUR
} = require('./config');
const {th} = require("date-fns/locale");
const config = require("./config");

let maxTries = MAX_NUMBER_OF_POLL

const login = async (page) => {
    logStep('logging in');
    const response = await page.goto(siteInfo.LOGIN_URL);
    // console.log(response.status());
    // console.log(response.headers());
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

    // Wait for the form to be available
    // await page.waitForSelector("form#sign_in_form");
    // console.log(await page.content());

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
    const formattedDate = format(earliestDate, 'dd-MM-yyyy');
    logStep(`sending an email to schedule for ${formattedDate}. Available times are: ${availableTimes}`);
    await sendEmail({
        subject: `We found an earlier date ${formattedDate}`,
        text: `Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`
    })
}

const reschedule = async (page, earliestDate, availableTimes) => {
    const formattedDate = format(earliestDate, 'yyyy-MM-dd');
    if (availableTimes[0] != null) {
        logStep(`Rescheduling for ${formattedDate} at ${availableTimes[0]}`);

        await page.goto(siteInfo.APPOINTMENTS_URL);

        await page.select('select#appointments_consulate_appointment_facility_id', siteInfo.FACILITY_ID);

        const date = await page.waitForSelector("input#appointments_consulate_appointment_date");

        await delayMs(1000);
        await date.click();
        await delayMs(1000);

        // await debug(page, '#_1_appointments_consulate_appointment_before_date', true);

        const [year, month, day] = formattedDate.split('-');

        const zeroBasedMonth = parseInt(month, 10) - 1;

        const tdSelector = `td.undefined[data-handler="selectDay"][data-event="click"][data-month="${zeroBasedMonth}"][data-year="${year}"]`;
        const linkSelector = 'a.ui-state-default';
        const nextButtonSelector = 'a.ui-datepicker-next[data-handler="next"]';

        let isDateVisible = false;
        while (!isDateVisible) {
            // Check if the <td> element is in the DOM
            isDateVisible = await page.evaluate((tdSelector) => {
                return !!document.querySelector(tdSelector);
            }, tdSelector);

            // If not visible, click the "Next" button
            if (!isDateVisible) {
                await page.click(nextButtonSelector);
                await delayMs(1000);
            }
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

        console.log('Date clicked successfully.');

        // await debug(page, '#_2_appointments_consulate_appointment_date', true);

        const time = await page.waitForSelector('select#appointments_consulate_appointment_time');
        time.select('select#appointments_consulate_appointment_time', availableTimes[0]);

        // await debug(page, '#_3_appointments_consulate_appointment_time', true);

        await page.waitForSelector('input#appointments_submit');
        await page.click('input#appointments_submit');

        await debug(page, '#_4', true);

        await page.waitForSelector('a.alert');
        await page.click('a.alert');

        await page.waitForNavigation();
        await debug(page, '#_5', true);
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
}

// Send a notification to telegram
const sendTelegramNotification = (message) => {
    const botToken = config.telegram.NOTIFY_TG_TOKEN; // Replace with your bot token
    const chatId = config.telegram.NOTIFY_TG_CHAT_ID; // Replace with the group's chat ID

    const bot = new TelegramBot(botToken, {polling: true});

    const sendNotification = (message) => {
        bot.sendMessage(chatId, message)
            .then(() => console.log('Notification sent!'))
            .catch((err) => console.error('Error sending notification:', err));
    }
    sendNotification(message);
};


const notifyMeViaTelegram = async (earliestDate, availableTimes) => {
    if (config.telegram.NOTIFY_TG_TOKEN === '' || config.telegram.NOTIFY_TG_CHAT_ID === '') {
        logStep('Telegram token or chat id is not provided, skipping telegram notification');
        return;
    }
    const formattedDate = format(earliestDate, 'dd-MM-yyyy');
    logStep(`sending an TG notification to schedule for ${formattedDate}. Available times are: ${availableTimes}`);

    sendTelegramNotification(`Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`);
}


const getMainPageDetails = async (page) => {
    logStep('checking main page details for current booking date');
    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });

    await page.goto(siteInfo.BASE_DATA_URL);

    const originalPageContent = await page.content();

    try {
        const bodyText = await page.evaluate(() => {
            return document.querySelector('.consular-appt').innerText
        });

        const match = bodyText.match(/(\d{1,2} \w+, \d{4}, \d{2}:\d{2})/);

        if (match) {
            console.log(match[1]); // Output: 10 April, 2026, 09:45 Vancouver local time
        } else {
            console.log("No match found");
        }
        // Vancouver is in GMT-7 for local time
        const parsedDate = new Date(match[1] + " GMT-7");
        logStep(`Parsed booked date: ${parsedDate} from profile`);

        // console.log("Parsed Date:", parsedDate.toISOString()); // Outputs date in ISO 8601 format

        // Subtract 2 days
        const twoDaysInMilliseconds = 2 * 24 * 60 * 60 * 1000; // 2 days in milliseconds
        const newDate = new Date(parsedDate.getTime() - twoDaysInMilliseconds);
        logStep(`Booked date -2 days to compare: ${newDate}`);
        return newDate;
    } catch (err) {
        console.log("Unable to parse details page content", originalPageContent);
        console.error(err)
    }
}

const checkForSchedules = async (page) => {
    logStep('checking for schedules');
    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });
    await page.goto(siteInfo.APPOINTMENTS_JSON_URL);

    const originalPageContent = await page.content();
    const bodyText = await page.evaluate(() => {
        return document.querySelector('body').innerText
    });

    try {
        const parsedBody = JSON.parse(bodyText);

        if (!Array.isArray(parsedBody)) {
            throw "Failed to parse dates, probably because you are not logged in";
        }

        const dates = parsedBody.map(item => parseISO(item.date));
        const [earliest] = dates.sort(compareAsc)

        return earliest;
    } catch (err) {
        console.log("Unable to parse page JSON content", originalPageContent);
        console.error(err)
    }
}

const checkForAvailableTimes = async (page, earliestDateStr) => {
    logStep(`checking for available times on the ${earliestDateStr}`);

    await page.setExtraHTTPHeaders({
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });

    const url = getAvailableTimesUrl(earliestDateStr);
    await page.goto(url);

    const originalPageContent = await page.content();
    const bodyText = await page.evaluate(() => {
        return document.querySelector('body').innerText
    });

    try {
        const parsedBody = JSON.parse(bodyText);
        const availableTimes = parsedBody.available_times;
        if (availableTimes.length > 0 && availableTimes[0] == null) {
            logStep(`NO available times for the date : ${earliestDateStr} response : ${JSON.stringify(parsedBody)}`);
            return;
        }
        logStep(`available time for the date : ${earliestDateStr} is : ${availableTimes} :: response : ${JSON.stringify(parsedBody)}`);
        return availableTimes;
    } catch (err) {
        console.log("Unable to parse page JSON content", originalPageContent);
        console.error(err)
    }
}

const process = async () => {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const browser = await puppeteer.launch(!IS_PROD ? {headless: false} : {args: ['--no-sandbox', '--disable-setuid-sandbox']});

    logStep(`starting process with ${maxTries} tries left`);

    const now = new Date();
    const currentHour = now.getHours()

    if (currentHour >= SLEEP_HOUR || currentHour < WAKEUP_HOUR) {
        logStep("After hours, doing nothing")
    } else {
        try {
            if (maxTries-- <= 0) {
                sendTelegramNotification('Max retries reached. Please restart the process.');
                console.log('Reached Max tries')
                return
            }
            const page = await browser.newPage();

            await login(page);

            const currentDate = await getMainPageDetails(page);

            const checkForScheduleDate = await checkForSchedules(page);

            if (checkForScheduleDate) {
                const earliestDate = findEarliestDate([currentDate, checkForScheduleDate]);

                let earliestDateStr = format(earliestDate, 'yyyy-MM-dd');
                let availableTimes = await checkForAvailableTimes(page, earliestDateStr);

                logStep(`Earliest date found is ${earliestDateStr}, available times are ${availableTimes}`);

                let diff = Math.round((earliestDate - now) / (1000 * 60 * 60 * 24))

                const row = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString() + "," + earliestDateStr + "," + diff + "," + availableTimes + "\n"

                fs.appendFile('./dates.csv', row, err => {
                    if (err) {
                        console.error(err);
                    }
                });

                if (earliestDate && availableTimes && isBefore(earliestDate, parseISO(NOTIFY_ON_DATE_BEFORE))) {
                    await notifyMeViaTelegram(earliestDate, availableTimes);
                    await reschedule(page, earliestDate, availableTimes);
                    await notifyMe(earliestDate, availableTimes);
                }
            }
        } catch (err) {
            console.error(err);
        }

        await browser.close();
    }

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

async function delayMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}