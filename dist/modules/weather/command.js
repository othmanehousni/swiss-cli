import { App, parsePositiveInt, sourceClient, UserError, } from '../../commands/shared.js';
import { looseKey } from '../../normalization/text.js';
import { ProgressLine } from '../../ui/output.js';
import { formatClock } from '../../util/when.js';
import { compass, distanceKm } from '../places/geo.js';
import { otherPlacesHint, resolvePlace } from '../places/resolve.js';
import { dailyForecast, forecastPointFor, latestMeasurement, loadForecastPoints, loadWeatherStations, nearestStation, } from './meteoswiss.js';
import { SYMBOLS } from './symbols.js';
const EXAMPLES = `
Examples:
  $ swiss weather 1003                    Lausanne
  $ swiss weather Davos --days 3
  $ swiss weather Jungfraujoch            mountain spots have their own forecast
  $ swiss weather 8001 --json

The forecast is MeteoSwiss's local forecast (updated hourly, 9 days); "now" is the
latest measurement of the nearest MeteoSwiss weather station. Source: MeteoSwiss.`;
const LANG_INDEX = { en: 0, de: 1, fr: 2, it: 3 };
/** What a pictogram means, in English unless another language was chosen. */
export function describeSymbol(symbol, lang = 'en') {
    if (symbol === null)
        return '–';
    return SYMBOLS[symbol]?.[LANG_INDEX[lang]] ?? `weather ${symbol}`;
}
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
/** "2026-10-27" -> "Tue 27.10." */
export function dayLabel(date) {
    const day = new Date(`${date}T12:00:00Z`);
    return `${WEEKDAY.format(day)} ${date.slice(8, 10)}.${date.slice(5, 7)}.`;
}
const temperature = (value) => (value === null ? '–' : `${Math.round(value)}°`);
/** "8.1 °C · humidity 91% · wind 7 km/h from SW, gusts 15 · 0.4 mm of rain in the last hour" */
export function describeNow(now) {
    const parts = [];
    if (now.temperature !== null)
        parts.push(`${now.temperature.toFixed(1)} °C`);
    if (now.humidity !== null)
        parts.push(`humidity ${Math.round(now.humidity)}%`);
    if (now.wind !== null) {
        const from = now.direction === null || now.wind < 2 ? '' : ` from ${compass(now.direction)}`;
        const gusts = now.gusts !== null && now.gusts >= now.wind + 5 ? `, gusts ${Math.round(now.gusts)}` : '';
        parts.push(`wind ${Math.round(now.wind)} km/h${from}${gusts}`);
    }
    if (now.rainLastHour !== null) {
        parts.push(now.rainLastHour > 0 ? `${now.rainLastHour} mm of rain in the last hour` : 'dry');
    }
    if (now.snow !== null && now.snow > 0)
        parts.push(`${Math.round(now.snow)} cm of snow`);
    return parts.join(' · ');
}
export function registerWeatherCommand(program) {
    program
        .command('weather')
        .alias('forecast')
        .summary('MeteoSwiss forecast for 9 days and the latest measurement nearby')
        .description('The MeteoSwiss local forecast for a place (weather, lowest and highest temperature, ' +
        'rain per day) and the latest measurement of the nearest weather station.')
        .argument('<place...>', 'postcode, municipality, address or mountain, e.g. 1003 or Davos')
        .option('--days <count>', 'how many days to show (up to 9)', '7')
        .option('--json', 'machine-readable output')
        .addHelpText('after', EXAMPLES)
        .action(async (words, opts, command) => {
        const app = new App(command.optsWithGlobals(), opts.json === true);
        try {
            await weather(app, words.join(' '), opts);
        }
        finally {
            app.close();
        }
    });
}
async function weather(app, text, opts) {
    const { out } = app;
    const days = Math.min(parsePositiveInt(String(opts.days ?? '7'), '--days'), 9);
    // Names follow --lang or SWISS_GROCERY_LANG when chosen; English otherwise, like the rest.
    const lang = app.options.lang ?? (process.env.SWISS_GROCERY_LANG ? app.langFor() : 'en');
    const db = app.db();
    const http = sourceClient(app, 'meteoswiss');
    const progress = new ProgressLine(out);
    let result;
    let resolved;
    let place;
    try {
        progress.update('Finding the place…');
        resolved = await resolvePlace(db, http, text);
        place = resolved.place;
        progress.update('Loading the MeteoSwiss forecast…');
        const points = await loadForecastPoints(db, http);
        // A station or mountain spot MeteoSwiss names as typed ("Säntis", "Pilatus") beats
        // a search hit or a locality, which may be a field or a valley postcode of that name.
        const key = looseKey(text);
        const named = place.kind !== 'postcode' && looseKey(place.municipality ?? '') !== key
            ? points.find((p) => p.type !== 2 && looseKey(p.name) === key)
            : undefined;
        if (named) {
            place = { ...place, label: named.name, lat: named.lat, lon: named.lon, kind: 'name' };
        }
        const point = named ?? forecastPointFor(points, place);
        if (!point)
            throw new UserError(`MeteoSwiss has no forecast for ${place.label}.`);
        const forecast = await dailyForecast(db, http, point);
        if (forecast.days.every((d) => d.symbol === null && d.max === null)) {
            throw new UserError(`MeteoSwiss has no forecast for ${point.name} right now.`, [
                'Try again in a few minutes, or a nearby postcode.',
            ]);
        }
        progress.update('Loading the latest measurements…');
        const station = nearestStation(await loadWeatherStations(db, http), place, point.height);
        // The measurement is a bonus: the forecast is shown without it.
        const now = station
            ? await latestMeasurement(db, http, station.station).catch(() => null)
            : null;
        result = { forecast, point, station, now };
    }
    finally {
        progress.clear();
    }
    const { forecast, point, station, now } = result;
    const shown = forecast.days.slice(0, days);
    if (out.options.json) {
        out.json({
            place: { label: place.label, lat: place.lat, lon: place.lon, canton: place.canton },
            forecastPoint: { name: point.name, postcode: point.postcode, height: point.height },
            run: forecast.run,
            days: shown.map((d) => ({ ...d, weather: describeSymbol(d.symbol, lang) })),
            now: station && now
                ? {
                    station: station.station.name,
                    stationHeight: station.station.height,
                    distanceKm: Math.round(station.km * 10) / 10,
                    ...now,
                }
                : null,
            source: 'MeteoSwiss',
            fetchedAt: forecast.fetchedAt,
        });
        return;
    }
    const height = point.height === null ? null : `${Math.round(point.height)} m`;
    const note = place.kind === 'search'
        ? `forecast for ${point.name}, ${distanceKm(point, place).toFixed(1)} km away${height ? `, ${height}` : ''}`
        : [place.label === point.name ? null : place.canton, height].filter(Boolean).join(' · ');
    out.print();
    out.print(`  ${out.c.bold(`Weather · ${place.label}`)}${note ? out.c.dim(` · ${note}`) : ''}`);
    out.print();
    if (station && now) {
        out.print(`  ${out.c.bold('Now')}  ${describeNow(now)}`);
        out.print(out.c.dim(`       at ${station.station.name} (${station.km < 1 ? 'here' : `${station.km.toFixed(0)} km away`}` +
            `${station.station.height === null ? '' : `, ${Math.round(station.station.height)} m`}), ${formatClock(Date.parse(now.time) / 1000)}`));
        out.print();
    }
    out.table(shown, [
        { header: 'Day', value: (d) => dayLabel(d.date) },
        { header: 'Weather', value: (d) => describeSymbol(d.symbol, lang), flex: true },
        {
            header: 'Low',
            value: (d) => temperature(d.min),
            align: 'right',
            style: (t) => out.c.cyan(t),
        },
        {
            header: 'High',
            value: (d) => temperature(d.max),
            align: 'right',
            style: (t) => out.c.yellow(t),
        },
        {
            header: 'Rain',
            value: (d) => (d.rain === null ? '–' : d.rain < 0.1 ? '–' : `${d.rain.toFixed(1)} mm`),
            align: 'right',
        },
    ]);
    out.print();
    if (forecast.stale) {
        out.warn(`MeteoSwiss could not be reached: this is the forecast from ${forecast.fetchedAt.slice(0, 16).replace('T', ' ')} UTC.`);
    }
    const run = forecast.run;
    const runTime = formatClock(Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10), +run.slice(10, 12)) / 1000);
    out.info(out.c.dim(`  Source: MeteoSwiss (local forecast of ${runTime}, weather stations)`));
    const hint = place.kind === 'search' ? null : otherPlacesHint(resolved, 'swiss weather');
    if (hint)
        out.info(out.c.dim(`  ${hint}`));
}
