const puppeteer = require('puppeteer');
const {parseISO, compareAsc, isBefore, format} = require('date-fns')
require('dotenv').config();
const fs = require('fs');

const {delay, sendEmail, logStep} = require('./utils');
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

const notifyMeViaTelegram = async (earliestDate, availableTimes) => {
    const TelegramBot = require('node-telegram-bot-api');

    const botToken = config.telegram.NOTIFY_TG_TOKEN; // Replace with your bot token
    const chatId = config.telegram.NOTIFY_TG_CHAT_ID; // Replace with the group's chat ID

    const bot = new TelegramBot(botToken, { polling: true });

    const formattedDate = format(earliestDate, 'dd-MM-yyyy');
    logStep(`sending an TG notification to schedule for ${formattedDate}. Available times are: ${availableTimes}`);
    // Send a notification
    const sendNotification = (message) => {
        bot.sendMessage(chatId, message)
            .then(() => console.log('Notification sent!'))
            .catch((err) => console.error('Error sending notification:', err));
    };

    sendNotification(`Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`);
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

                const row = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString() + "," + earliestDateStr + "," + diff + "\n"

                fs.appendFile('./dates.csv', row, err => {
                    if (err) {
                        console.error(err);
                    }
                });

                if (earliestDate && isBefore(earliestDate, parseISO(NOTIFY_ON_DATE_BEFORE))) {
                    await notifyMeViaTelegram(earliestDate, availableTimes);
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