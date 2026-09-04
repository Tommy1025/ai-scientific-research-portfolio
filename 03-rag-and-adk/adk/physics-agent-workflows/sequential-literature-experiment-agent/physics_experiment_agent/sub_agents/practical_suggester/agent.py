from google.adk.agents import LlmAgent
from ...config import GEMINI_MODEL
from .prompt import get_suggester_instruction


INPUT_KEY = "analysis_report"

practical_suggester_agent = LlmAgent(
    name="PracticalSuggester",
    model=GEMINI_MODEL,
    instruction=get_suggester_instruction(INPUT_KEY),
)
