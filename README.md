# 🌌 Helios (ARIA IDE) | Premium AI-Native Code Editor

<p align="center">
  <img src="assets/workspace.png" alt="Helios / ARIA IDE Workspace Preview" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41.2.1-blue?style=for-the-badge&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19.2.5-61dafb?style=for-the-badge&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/Vite-8.0.8-646CFF?style=for-the-badge&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" />
</p>

**Helios (ARIA - Adaptive Runtime Intelligent Assistant)** is a premium, high-performance, AI-native IDE built from the ground up to integrate deep workspace analysis with state-of-the-art Large Language Models. Featuring a tailored high-contrast dual-dark aesthetic (Pure Black / Deep Charcoal) and micro-animations, Helios makes development faster, more intelligent, and visually immersive. It serves as a fully featured, free desktop alternative to Cursor, Trae, and Claude Code.

---

## 🎬 Startup Experience & Animation

Helios opens with a fluid start-up animation screen that sets a premium, futuristic tone before seamlessly loading the workspace environment.

<p align="center">
  <video src="assets/start-animation.mp4" width="100%" controls autoplay loop muted></video>
</p>

---

## ✨ Key Features & Capabilities

### 1. 🤖 Multi-Model Comparative Chat & Smart Mode
*   **Parallel Execution Comparison**: Query multiple AI models at once and view their responses side-by-side inside high-contrast comparative workspace panels. Ideal for comparing output quality or speed between models.
*   **Smart Mode (Planner/Coder/Reviewer)**: Toggle Smart Mode to run a multi-stage agentic pipeline. The AI will plan the architecture first, write the code, and perform a security/bug check review automatically.
*   **Three-Agent Agentic Pipeline**: Deploy a cooperative development workflow where separate models act as the **Planner**, **Coder**, and **Reviewer** sequentially.
    *   *Planner*: Designs the architecture and layout steps.
    *   *Coder*: Writes and modifies the codebase.
    *   *Reviewer*: Inspects security, checks bugs, and suggests styling/performance enhancements.

<p align="center">
  <img src="assets/model_comparison.png" alt="ARIA IDE Multi-Model Comparative Chat" width="49%" />
  <img src="assets/smart_mode.png" alt="Smart Mode Chat" width="49%" />
</p>

### 2. ⚙️ Connect Provider Popup Overlay & Advanced Settings
*   **API Providers**: Search and connect from over 100+ pre-configured AI providers (OpenAI, Anthropic, DeepSeek, Google Gemini, Groq, OpenRouter, NVIDIA NIM, and more) or connect custom manual endpoints.
*   **Model Priorities**: Custom-tune which models are preferred for specific workflows like planning, coding, chatting, or reviewing.
*   **MCP Servers (Model Context Protocol)**: Connect external MCP servers to extend the AI's capabilities, allowing it to interact directly with databases, external APIs, and local systems.

<p align="center">
  <img src="assets/settings.png" alt="Helios / ARIA IDE Settings Overlay" width="49%" />
  <img src="assets/model_priorities.png" alt="Model Priorities Settings" width="49%" />
</p>

<p align="center">
  <img src="assets/mcp_servers.png" alt="MCP Servers Integration" width="80%" />
</p>

### 3. 🌀 Dynamic Model Fetching
*   Connect custom API endpoints (e.g., Ollama, LM Studio, or local setups) and automatically query the `/v1/models` endpoint using standard Bearer tokens.
*   Automatically populates 100% of custom local and remote models dynamically inside the workspace selection panel.

### 4. 🎛️ AI Commands & File Writing
*   Helios's AI agent can propose modifications, create new files, and automatically run shell commands via the integrated, interactive terminal to verify code.

### 5. 💻 High-Contrast Editor Canvas
*   Professional-grade code compilation powered by **Monaco Editor** under a premium layout.
*   Supports toggling between an ultra-sleek **Pure Black** layout (`#000000`) and a **Deep Charcoal** GitHub-like styling (`#0d1117`) via a single toggle button in the header.

### 6. 🐚 Fully Interactive Shell Terminal
*   Runs a fully featured terminal session built with `xterm.js` and `wait-on`, with automatic resizing (Fit addon) and a "Stop Process / Reset" control to terminate running scripts.

---

## 📖 How to Use

Follow this step-by-step workflow to get the most out of Helios:

### Step 1: Open Your Project Folder
*   Click **File > Open Folder...** (or press `Ctrl+Shift+O`) to load your project directory. 
*   Helios will immediately start indexing your codebase to build a symbol database, which the AI models use as context for workspace queries.

### Step 2: Configure AI Keys
*   Click the **Settings Gear Icon** in the top-right corner of the title bar to open the **Connect Provider Overlay**.
*   Select your preferred AI provider (e.g., OpenAI, Anthropic, or DeepSeek) and paste your API key.
*   For local models (Ollama/LM Studio), toggle the Custom Endpoint switch, enter your URL, and Helios will dynamically fetch all active models.

<p align="center">
  <img src="assets/api_key_setup.png" alt="ARIA IDE API Key Setup" width="80%" />
</p>


### Step 3: Prompting & Comparative Chat
*   Open the AI Chat panel (`Ctrl+L`).
*   Select the AI models you wish to use from the model dropdown.
*   *For comparative analysis*: Toggle **Compare Mode**, ask your coding question, and view the side-by-side outputs.
*   *For agentic coding*: Select **Agent Mode** and describe what you want built. The system will plan, write, and review the code automatically.

### Step 4: Edit, Run, and Verify
*   Open and edit files in the Monaco editor.
*   To run your active file, press `F5` (or click **Run > Run Active File**). Helios automatically detects your file extension (`.js`, `.py`, `.go`, `.rs`, `.cpp`, `.html`) and executes the proper compile/run command inside the integrated terminal panel.

---

## 💻 Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `Ctrl + N` | Create a New File |
| `Ctrl + O` | Open a File |
| `Ctrl + Shift + O` | Open a Folder / Workspace |
| `Ctrl + S` | Save Current File |
| `Ctrl + Shift + S` | Save File As |
| `Ctrl + B` | Toggle File Explorer Sidebar |
| `Ctrl + \`` (backtick) | Toggle Shell Terminal Panel |
| `Ctrl + L` | Toggle AI Chat Sidebar |
| `Ctrl + G` | Go to Line / File |
| `F5` | Run Active File / Start Debugging |
| `F12` | Go to Symbol Definition / Toggle DevTools |
| `Ctrl + =` | Zoom In Workspace |
| `Ctrl + -` | Zoom Out Workspace |
| `Ctrl + 0` | Reset Zoom |

---

## 🔒 Code Security & Packaging Pipeline

To protect developer attribution and enforce runtime integrity:
*   **Active main.js Obfuscation**: The packager compiles and scramble-obfuscates `main.js` backend scripts, making decompilers useless.
*   **Self-Defending Modules**: Anti-tampering features prevent code formatting or unauthorized credit edits by causing the app to freeze/crash on modification.
*   **Encrypted Strings**: Credit signatures are scrambled with Base64 key tables.

---

## 🛠️ Project Architecture

```text
Helios/
├── assets/            # Workspace previews, screenshots & start animation video
├── services/          # Backend modules (Git integration, codebase indexing)
├── src/
│   ├── components/    # React Workspace layout, Settings modal, comparative views
│   ├── styles/        # Pure black stylesheets & animations
│   ├── App.jsx        # Core UI & state controller
│   └── main.jsx       # Client entrypoint
├── main.js            # Electron Main controller (CommonJS)
├── preload.js         # Context bridge
└── package.js         # Obfuscation & packing script
```

---

## 🚀 Getting Started (Portable Release)

No installation or node setup is required! ARIA is distributed as a pre-packaged portable Windows application.

### Running the App:
1. Locate the `ARIA-Portable.zip` file in the root of the repository (or download it).
2. Extract the ZIP file's contents to a folder on your computer.
3. Open the extracted folder `ARIA-win32-x64` and run **`ARIA.exe`** to launch the editor immediately.

---

## 📜 Attribution & Credits

Created with ❤️ by **Mohammed Awais (AM)**.

*This project is distributed for educational and development purposes. Unauthorized modifications of developer attributions or removal of credit signatures are strictly prohibited by the application's built-in self-defense and integrity mechanisms.*
