"""Optional Open-Meteo forecast adapter; never applies an unvalidated penalty."""

from __future__ import annotations

from projection_sources.cache import GEOCODING_BASE, OPEN_METEO_BASE, open_meteo_json


def forecast(city: str | None, state: str | None, kickoff: str | None, indoor: bool | None):
    if indoor:
        return {"available": False, "reason": "Indoor game; outdoor weather exposure does not apply."}
    if indoor is None:
        return {"available": False, "reason": "NFL venue roof type is unavailable; outdoor weather exposure is not assumed."}
    if not city or not kickoff:
        return {"available": False, "reason": "A verified venue location and kickoff timestamp are required."}
    query = ", ".join(part for part in (city, state) if part)
    geo, geo_meta = open_meteo_json(f"{GEOCODING_BASE}/search", {"name": query, "count": 1,
                              "language": "en", "format": "json"}, f"open-meteo-geocode:{query.casefold()}", 30 * 86400)
    places = (geo or {}).get("results") or []
    if not places:
        return {"available": False, "reason": "Open-Meteo could not resolve the NFL venue location.", "source_status": geo_meta}
    place = places[0]
    weather, weather_meta = open_meteo_json(f"{OPEN_METEO_BASE}/forecast", {
        "latitude": place["latitude"], "longitude": place["longitude"],
        "hourly": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m,weather_code",
        "timezone": "UTC", "forecast_days": 7,
    }, f"open-meteo-forecast:{place['latitude']}:{place['longitude']}", 1800)
    hourly = (weather or {}).get("hourly") or {}
    times = hourly.get("time") or []
    target = kickoff[:13]
    index = next((i for i, stamp in enumerate(times) if stamp[:13] == target), None)
    if index is None:
        return {"available": False, "reason": "Forecast response did not include the kickoff hour.", "source_status": weather_meta}
    def at(name):
        values = hourly.get(name) or []
        return values[index] if index < len(values) else None
    return {"available": True, "temperature_c": at("temperature_2m"), "wind_kph": at("wind_speed_10m"),
            "precipitation_mm": at("precipitation"), "rain_mm": at("rain"), "snowfall_cm": at("snowfall"),
            "weather_code": at("weather_code"), "location": place.get("name"), "source": "Open-Meteo",
            "source_url": weather_meta.get("url"), "retrieved_at": weather_meta.get("retrieved_at"),
            "stale": weather_meta.get("stale", False),
            "adjustment_policy": "Forecast is shown as real context. No numeric penalty is applied without a calibrated historical effect."}
