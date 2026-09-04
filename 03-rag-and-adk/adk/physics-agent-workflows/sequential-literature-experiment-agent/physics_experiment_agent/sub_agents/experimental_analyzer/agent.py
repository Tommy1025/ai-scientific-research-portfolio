from google.adk.agents import LlmAgent
from physics_experiment_agent.config import GEMINI_MODEL
from .prompt import get_analyzer_instruction


INPUT_KEY_FROM_B = "found_literature"
OUTPUT_KEY_TO_D = "analysis_report"

experimental_analyzer_agent = LlmAgent(
    name="ExperimentalAnalyzer",
    model=GEMINI_MODEL,
    include_contents="default",
    output_key=OUTPUT_KEY_TO_D,
    instruction=get_analyzer_instruction(INPUT_KEY_FROM_B),
)
