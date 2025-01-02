import {logStep, sendEmail} from "./utils";

const notifyMeViaEmail = async (formattedDate, availableTimes) => {
    logStep(`sending an email to schedule for ${formattedDate}. Available times are: ${availableTimes}`);
    await sendEmail({
        subject: `We found an earlier date ${formattedDate}`,
        text: `Hurry and schedule for ${formattedDate} before it is taken. Available times are: ${availableTimes}`
    })
}