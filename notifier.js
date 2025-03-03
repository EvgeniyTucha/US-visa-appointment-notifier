require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const config = require("./config");
const {da} = require("date-fns/locale");
const {logStep} = require("./utils");

const botToken = config.telegram.NOTIFY_TG_TOKEN;
const chatId = config.telegram.NOTIFY_TG_CHAT_ID;

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

module.exports = {
    sendTelegramNotification,
    sendTelegramScreenshot
}