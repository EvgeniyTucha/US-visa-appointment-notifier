const formData = require('form-data');

const config = require('./config');

const debug = async (page, logName, saveScreenShot) => {
    if (saveScreenShot) {
        await page.screenshot({path: `${logName}.png`, fullPage: true});
    }

    await page.evaluate(() => {
        debugger;
    });
};

const delay = timeout => {
    const timeoutInMs = timeout * 60 * 1000
    return new Promise(resolve => setTimeout(resolve, timeoutInMs))
};

const logStep = (stepTitle) => {
    const isoDateTime = getIsoDateWithTimezoneOffset(new Date());
    console.log(`${isoDateTime} ==> Step: ${stepTitle}`);
}

const getIsoDateWithTimezoneOffset = (date) => {
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString();
}

module.exports = {
    debug,
    delay,
    logStep,
    getIsoDateWithTimezoneOffset
}
