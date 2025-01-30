const {th} = require("date-fns/locale");
module.exports = {
    loginCred: {
        EMAIL: process.env.EMAIL,
        PASSWORD: process.env.PASSWORD
    },

    siteInfo: {
        COUNTRY_CODE: process.env.COUNTRY_CODE || 'en-ca',
        SCHEDULE_ID: process.env.SCHEDULE_ID,
        FACILITY_ID: process.env.FACILITY_ID,

        get APPOINTMENTS_URL() {
            return `https://ais.usvisa-info.com/${this.COUNTRY_CODE}/niv/schedule/${this.SCHEDULE_ID}/appointment`
        },

        get APPOINTMENTS_JSON_URL() {
            return this.APPOINTMENTS_URL + `/days/${this.FACILITY_ID}.json?appointments%5Bexpedite%5D=false`
        },

        get AVAILABLE_TIMES_URL() {
            return this.APPOINTMENTS_URL + `/times/${this.FACILITY_ID}.json`
        },

        get LOGIN_URL() {
            return `https://ais.usvisa-info.com/${this.COUNTRY_CODE}/niv/users/sign_in`
        },

        get BASE_DATA_URL() {
            return `https://ais.usvisa-info.com/${this.COUNTRY_CODE}/niv`
        }
    },
    IS_PROD: process.env.NODE_ENV === 'prod',
    NEXT_SCHEDULE_POLL_MIN: process.env.NEXT_SCHEDULE_POLL_MIN || 15, // default to 15 minutes
    MAX_NUMBER_OF_POLL: process.env.MAX_NUMBER_OF_POLL || 250, // number of polls before stopping
    NOTIFY_ON_DATE_BEFORE: process.env.NOTIFY_ON_DATE_BEFORE, // in ISO format i.e YYYY-MM-DD
    EARLIEST_DATE_SHIFT: process.env.EARLIEST_DATE_SHIFT || 1, // default to 1 day shift

    NOTIFY_EMAILS: process.env.NOTIFY_EMAILS, // comma separated list of emails
    telegram: {
        NOTIFY_TG_CHAT_ID: process.env.NOTIFY_TG_CHAT_ID, // chat id to send notification
        NOTIFY_TG_TOKEN: process.env.NOTIFY_TG_TOKEN, // tg token
    }
}
