const fs = require("fs");
const {sendTelegramNotification} = require('./notifier');

module.exports = async function getClosestDates() {
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