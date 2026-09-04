# Part of agent.py --> Follow https://google.github.io/adk-docs/get-started/quickstart/ to learn the setup
# 物理實驗助教系統 - 嚴格審查版
import asyncio
import os
from google.adk.agents import LoopAgent, LlmAgent, BaseAgent, SequentialAgent
from google.genai import types
from google.adk.runners import InMemoryRunner
from google.adk.agents.invocation_context import InvocationContext
from google.adk.tools.tool_context import ToolContext
from typing import AsyncGenerator, Optional
from google.adk.events import Event, EventActions

# --- Constants ---
APP_NAME = "physics_experiment_assistant_v3"
USER_ID = "student_01"
SESSION_ID_BASE = "physics_experiment_session"
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_PRO_MODEL = "gemini-2.5-flash"  # Use same model for consistency and speed

# --- State Keys ---
STATE_EXPERIMENT_TOPIC = "experiment topic"
STATE_CURRENT_PROCEDURE = "current experiment procedure"
STATE_EXPERT_REVIEW = "expert review"
STATE_ITERATION_COUNT = "iteration count"

# Define the exact phrase the Expert Reviewer should use to signal completion
COMPLETION_PHRASE = "實驗程序完全合格，批准發布。"

# --- Tool Definition ---
def finalize_experiment(tool_context: ToolContext):
    """當專家審查者認為實驗程序已經完善時，調用此函數結束迭代過程。"""
    print(f"  [Tool Call] finalize_experiment triggered by {tool_context.agent_name}")
    # 記錄完成狀態
    tool_context.state["experiment status"] = "approved"
    tool_context.actions.escalate = True
    return {"status": "experiment_approved"}

# --- Agent Definitions ---

# STEP 1: 初始實驗程序設計者 (運行一次)
initial_procedure_designer = LlmAgent(
    name="InitialProcedureDesigner",
    model=GEMINI_MODEL,
    include_contents='none',
    instruction=f"""你是一位物理實驗助教，負責設計初步的實驗程序草稿。

**實驗主題**：{{{STATE_EXPERIMENT_TOPIC}}}

設計一個包含以下5個部分的實驗程序：

## 實驗目的
簡要說明要驗證的物理定律或測量的物理量。

## 實驗器材  
列出3-5種必要的實驗設備和材料。

## 實驗步驟
提供3-5個基本操作步驟。

## 數據記錄
說明需要測量的物理量和記錄表格。

## 數據分析方法
簡述分析方法和計算公式。

**注意**：這只是初稿，專家會進行詳細審查和改進建議。
只輸出實驗程序內容，不要添加其他說明。
""",
    description="設計實驗程序的初步草稿，為後續審查和改進提供基礎。",
    output_key=STATE_CURRENT_PROCEDURE
)

# STEP 2a: 平衡的專家審查者 (在改進循環中)
expert_reviewer_in_loop = LlmAgent(
    name="BalancedExpertReviewer",
    model=GEMINI_PRO_MODEL,
    include_contents='none',
    instruction=f"""你是資深物理實驗專家，進行高效的專業審查。

**實驗主題**：{{{STATE_EXPERIMENT_TOPIC}}}

**實驗程序**：
{{{STATE_CURRENT_PROCEDURE}}}

**快速審查重點**：
1. 是否符合實驗主題「{{{STATE_EXPERIMENT_TOPIC}}}」
2. 實驗步驟是否可操作且邏輯清晰
3. 器材選擇是否實用合理
4. 數據分析方法是否具體明確

**審查方式**：
- 如果發現**明顯問題**（如：步驟不清楚、缺少重要器材、分析方法模糊），提供1-2個具體改進建議
- 如果程序基本合理、步驟清晰、符合主題，回應「{COMPLETION_PHRASE}」

**格式要求**：
- 發現問題時：直接指出問題並給出改進建議，保持簡潔
- 程序合格時：僅回應完成短語

審查結果：""",
    description="進行高效平衡的實驗程序審查，重點關注關鍵問題。",
    output_key=STATE_EXPERT_REVIEW
)

# STEP 2b: 高效改進者 (在改進循環中)  
procedure_improver_in_loop = LlmAgent(
    name="EfficientImprover",
    model=GEMINI_PRO_MODEL,
    include_contents='none',
    instruction=f"""你是物理實驗助教，根據專家意見快速改進程序。

**實驗主題**：{{{STATE_EXPERIMENT_TOPIC}}}

**當前程序**：
{{{STATE_CURRENT_PROCEDURE}}}

**專家意見**：
{{{STATE_EXPERT_REVIEW}}}

**處理方式**：
如果專家意見是「{COMPLETION_PHRASE}」：
→ 調用 finalize_experiment 工具

如果專家意見包含改進建議：
→ 針對建議進行改進，保持：
  • 圍繞主題「{{{STATE_EXPERIMENT_TOPIC}}}」
  • 維持原有格式結構
  • 解決專家指出的具體問題
  • 保持內容簡潔實用

輸出改進後的完整實驗程序。
""",
    description="根據專家意見進行高效的針對性改進。",
    tools=[finalize_experiment],
    output_key=STATE_CURRENT_PROCEDURE
)

# STEP 2: 平衡的改進循環代理
balanced_improvement_loop = LoopAgent(
    name="BalancedImprovementLoop", 
    sub_agents=[
        expert_reviewer_in_loop,    # 平衡的專家審查
        procedure_improver_in_loop, # 高效改進
    ],
    max_iterations=4  # 適中的迭代次數
)

# STEP 3: 整體序列管道
# 為了ADK工具相容性，根代理必須命名為 `root_agent`
root_agent = SequentialAgent(
    name="BalancedPhysicsExperimentAssistant",
    sub_agents=[
        initial_procedure_designer, # 創建初稿
        balanced_improvement_loop   # 平衡的審查和改進循環
    ],
    description="平衡高效的物理實驗助教系統：設計初稿後進行適度的專業審查和改進，確保質量與效率的最佳平衡。"
)
