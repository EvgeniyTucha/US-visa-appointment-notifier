const fs = require("fs");
const {sendTelegramNotification} = require('./notifier');
const {logStep} = require("./utils");

async function getClosestDates() {
    try {
        const csvData = fs.readFileSync('./dates.csv', 'utf-8');
        const rows = csvData.trim().split('\n');
        const now = new Date();
        const yesterdayISO = new Date(now.getTime() - (24 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60000))
            .toISOString()
            .slice(0, 10);
        logStep(`Closest dates found started for ${yesterdayISO}`)

        const dates = rows
            .map(row => {
                const [dateStr, returnDate, returnTime] = row.split(',').map(item => item.trim());
                return {compareDate: new Date(dateStr), returnDate, returnTime};
            })
            .filter(entry => entry.compareDate.toISOString().startsWith(yesterdayISO));

        let message = 'No dates found on: ' + yesterdayISO;
        if (dates.length > 0) {
            const closestDates = Array.from(
                new Set(dates.map(entry => `${entry.returnDate} ${entry.returnTime}`)) // Store date and time together
            )
                .sort((a, b) => new Date(a.split(' ')[0]) - new Date(b.split(' ')[0])) // Sort by returnDate
                .slice(0, 3);

            // Ensure closestDates always has 3 elements by padding with "N/A"
            while (closestDates.length < 3) {
                closestDates.push("N/A");
            }
            message = `Closest dates found on: ${yesterdayISO} : [ ${closestDates.join(', ')} ]`;
            logStep(message);
        }
        await sendTelegramNotification(message);
        logStep(`Closest dates found finished for ${yesterdayISO}`)
    } catch (error) {
        logStep(`Error reading or processing CSV file: ${error.message}`);
    }
}

async function logAnalyzer() {
    try {
        const logs = fs.readFileSync('npm_log.txt', 'utf-8').split('\n');
        const stats = {};
        const now = new Date();
        const targetDate = new Date(now.getTime() - (24 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60000))
            .toISOString().split('T')[0];
        const targetDateAsArray = targetDate.split('-');
        const datePattern = new RegExp(
            `\[(\d+)] ${targetDateAsArray[0]}-${targetDateAsArray[1]}-${targetDateAsArray[2]}T(\d+:\d+:\d+\.\d+Z) ==> `
        );        const regex = new RegExp(datePattern);
        logStep(`Log analyzer started for ${targetDate}`)
        logStep(`Log analyzer logs found size ${logs.length}`)

        logs.forEach(line => {
            const dateMatch = line.match(regex);
            if (!dateMatch) return;

            if (!stats[targetDate]) {
                stats[targetDate] = { up: 0, down: 0 };
            }

            if (line.includes('Step: earliest available date found: undefined')) {
                stats[targetDate].down++;
            } else if (line.includes('Step: earliest available date found:') && !line.includes('undefined')) {
                stats[targetDate].up++;
            }
        });

        // Calculate percentages
        Object.keys(stats).forEach(date => {
            const total = stats[date].up + stats[date].down;
            stats[date].total = total;
            stats[date].uptime = ((stats[date].up / total) * 100).toFixed(2);
            stats[date].downtime = ((stats[date].down / total) * 100).toFixed(2);
        });

        for (const date of Object.keys(stats)) {
            const { total, uptime, downtime } = stats[date];
            const statsMsg = `Statistics for ${date}\n ✅ Uptime: ${uptime}%\n ❌ Downtime: ${downtime}% \n Total checks: ${total}`
            await sendTelegramNotification(statsMsg);
            logStep(statsMsg);
        }
        logStep(`Log analyzer finished for ${targetDate}`)
    } catch (error) {
        logStep(`Error reading or processing log file: ${error.message}`);
    }
}

module.exports = {getClosestDates, logAnalyzer}