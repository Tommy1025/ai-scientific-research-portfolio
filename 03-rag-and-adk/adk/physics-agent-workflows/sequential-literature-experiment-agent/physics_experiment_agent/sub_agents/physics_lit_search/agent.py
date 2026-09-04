"""Physics literature/PDF intake agent."""

from google.adk.agents import Agent
from physics_experiment_agent.tools.pdf_tools import read_pdf
from physics_experiment_agent.config import GEMINI_MODEL
from . import prompt


physics_lit_search_agent = Agent(
    model=GEMINI_MODEL,
    name="physics_lit_search_agent",
    include_contents="default",
    instruction=prompt.PHYSICS_LIT_SEARCH_PROMPT,
    output_key="found_literature",
    tools=[read_pdf],
)
