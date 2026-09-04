# Portions adapted from the Google ADK Python multi-tool quickstart example.
# Copyright 2026 Google LLC
# Licensed under the Apache License, Version 2.0.
# Modifications include the NTNU/NTNUPHY information tool and agent configuration changes.

# 查詢紐約天氣、時間和大學資訊
import datetime
from zoneinfo import ZoneInfo
from google.adk.agents import Agent


# 工具：天氣
def get_weather(city: str) -> dict:
    """Retrieves the current weather report for a specified city.

    Args:
        city (str): The name of the city for which to retrieve the weather report.

    Returns:
        dict: status and result or error msg.
    """
    if city.lower() == "new york":
        return {
            "status": "success",
            "report": (
                "The weather in New York is sunny with a temperature of 25 degrees"
                " Celsius (77 degrees Fahrenheit)."
            ),
        }
    else:
        return {
            "status": "error",
            "error_message": f"Weather information for '{city}' is not available.",
        }


# 工具：時間
def get_current_time(city: str) -> dict:
    """Returns the current time in a specified city.

    Args:
        city (str): The name of the city for which to retrieve the current time.

    Returns:
        dict: status and result or error msg.
    """
    if city.lower() == "new york":
        tz_identifier = "America/New_York"
    else:
        return {
            "status": "error",
            "error_message": (
                f"Sorry, I don't have timezone information for {city}."
            ),
        }

    tz = ZoneInfo(tz_identifier)
    now = datetime.datetime.now(tz)
    report = (
        f'The current time in {city} is {now.strftime("%Y-%m-%d %H:%M:%S %Z%z")}'
    )
    return {"status": "success", "report": report}


# 工具：NTNU
def get_college(college: str) -> dict:
    """Retrieves basic information about NTNU and the NTNU Department of Physics.

    The tool accepts common variants such as "NTNU", "NTNU Physics",
    "National Taiwan Normal University", and Chinese NTNU names.

    Args:
        college (str): University or department name supplied by the agent.

    Returns:
        dict: A dictionary containing status and report/error information.
    """
    college_lower = college.strip().lower()

    english_aliases = (
        "ntnu",
        "national taiwan normal university",
    )
    chinese_aliases = (
        "國立臺灣師範大學",
        "國立台灣師範大學",
        "臺師大",
        "台師大",
        "師大物理",
    )

    is_ntnu_query = any(alias in college_lower for alias in english_aliases) or any(
        alias in college for alias in chinese_aliases
    )

    if is_ntnu_query:
        return {
            "status": "success",
            "report": (
                "NTNU Department of Physics is part of National Taiwan Normal University, "
                "established in 1946. The department offers comprehensive undergraduate and "
                "graduate programs in physics. It is well-known for its strong research in "
                "theoretical physics, condensed matter physics, optics, and quantum physics. "
                "The department has excellent faculty members and modern laboratory facilities, "
                "providing students with solid theoretical foundation and hands-on research experience. "
                "Many graduates pursue advanced degrees or careers in academia, industry, and technology sectors."
            ),
        }

    return {
        "status": "error",
        "error_message": (
            f"Information for '{college}' is not available. "
            "This demo tool currently supports NTNU / NTNU Physics only."
        ),
    }


root_agent = Agent(
    name="weather_time_college_agent",
    model="gemini-2.5-flash",
    description=(
        "Agent to answer questions about the time, weather in a city, and college information."
    ),
    instruction=(
        "You are a helpful agent who can answer user questions about the time and weather in a city, "
        "as well as provide information about colleges and universities. You can check the current time, "
        "get weather reports for cities, and retrieve information about educational institutions. "
        "Translate to Traditional Chinese."
    ),
    tools=[get_weather, get_current_time, get_college],
)
