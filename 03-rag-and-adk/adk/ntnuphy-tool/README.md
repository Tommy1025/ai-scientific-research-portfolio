# Google ADK Multi-Tool Agent: Weather, Time, and NTNUPHY

A small **Google Agent Development Kit (ADK)** tool-calling agent that exposes three Python functions to a Gemini-based agent.

## Functions

| Tool | Function |
|---|---|
| `get_weather(city)` | Returns a demonstration weather response for New York. |
| `get_current_time(city)` | Returns the current New York time using Python `zoneinfo`. |
| `get_college(college)` | Returns basic NTNU / NTNU Physics information. |

The weather response is intentionally static; this project does not call a live weather service.

## Architecture

```text
User query
   |
   v
Google ADK Agent
   |
   +-- get_weather()
   +-- get_current_time()
   +-- get_college()
   |
   v
Response
```

## Project Structure

```text
ntnuphy-tool/
├── README.md
├── requirements.txt
└── multi_tool_agent/
    ├── __init__.py
    ├── agent.py
    └── .env.example
```

## Setup

From this directory:

```bash
python -m venv .venv
```

Activate the environment.

**Windows PowerShell**

```powershell
.\.venv\Scripts\Activate.ps1
```

**macOS / Linux**

```bash
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Create a local environment file from the example:

**Windows PowerShell**

```powershell
Copy-Item multi_tool_agent/.env.example multi_tool_agent/.env
```

**macOS / Linux**

```bash
cp multi_tool_agent/.env.example multi_tool_agent/.env
```

Then edit `multi_tool_agent/.env` and replace the placeholder with a valid Gemini API key.

## Usage

### ADK Web UI

Run from the `ntnuphy-tool/` directory:

```bash
adk web
```

Open the local URL printed by ADK and select `multi_tool_agent`.

### Terminal

```bash
adk run multi_tool_agent
```

Example queries:

```text
What is the weather in New York?
What time is it in New York?
Tell me about NTNU Physics.
```

## Limitations

- Weather data is a fixed demonstration response, not live data.
- Time-zone support is limited to New York.
- University information is manually defined in the tool rather than retrieved from a live source.

## Attribution and License

The weather/time structure is adapted from the official Google ADK Python quickstart / multi-tool example. The NTNUPHY information tool is an added extension.

See the repository-level [`CONTRIBUTIONS.md`](../../../CONTRIBUTIONS.md) and [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) for contribution and third-party details.

Unless otherwise stated, this project is covered by the repository's Apache License 2.0.
