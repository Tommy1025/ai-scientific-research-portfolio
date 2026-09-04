from google.adk.agents import SequentialAgent

from .sub_agents.physics_lit_search.agent import physics_lit_search_agent
from .sub_agents.experimental_analyzer.agent import experimental_analyzer_agent
from .sub_agents.practical_suggester.agent import practical_suggester_agent


physics_pipeline = SequentialAgent(
    name="Physics_Expert_Pipeline",
    description="Physics Experiment Workflow: Search -> Analyze -> Suggest",
    sub_agents=[
        physics_lit_search_agent,
        experimental_analyzer_agent,
        practical_suggester_agent,
    ],
)

physics_experiment_agent = physics_pipeline
root_agent = physics_pipeline
