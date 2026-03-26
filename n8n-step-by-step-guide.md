# Step-by-Step Guide: Building the RE Scraper Pipeline in n8n

Follow these steps to build the pipeline manually in n8n. If you encounter an "Unrecognized node type" error for **Execute Command**, follow **Option B** below.

---

## Option A: Enable Execute Command (Recommended)
If you have access to the n8n server configuration:
1. Set the environment variable `N8N_BLOCK_COMMAND_EXECUTION=false`.
2. Restart n8n.
3. Import `n8n-pipeline-v2.json`.

---

## Option B: Use Scraper Server (HTTP-based)
If you cannot enable shell commands, use the built-in HTTP server.

### 0. Start the Scraper Server
Run this on the machine where the code is located:
```bash
node scraper-server.js
```
The server will listen on `http://localhost:3001`.

### 1. Import Workflow
Import `n8n-pipeline-http-v2.json` into n8n.

---

## Manual Build Steps (Standard)

### Step 1: Webhook Trigger
This node starts the workflow.
- **Action**: Add a **Webhook** node.
- **HTTP Method**: `POST`
- **Path**: `re-scraper-trigger`
- **Response Mode**: `When Last Node Finishes` (or `Response Node` if you use one).

---

### Step 2: Discover Projects (Execute Command)
Runs the discovery task to find new projects.
- **Action**: Add an **Execute Command** node.
- **Command**: 
  ```bash
  cmd /c "cd /d C:\SpringBoot\WorkSpace\re-scraper && node scraper-modular.js --source=housing --task=discover --limit=10"
  ```
- **Note**: Replace the path with your actual project path.

---

### Step 3: Parse Discovery (Code)
Converts the command output into n8n objects.
- **Action**: Add a **Code** node.
- **Language**: JavaScript
- **Code**:
  ```javascript
  const stdout = $json.stdout;
  try {
    const projects = JSON.parse(stdout);
    return projects.map(p => ({ json: p }));
  } catch (e) {
    throw new Error("Discovery failed or returned invalid JSON: " + stdout);
  }
  ```

---

### Step 4: Split In Batches
Processes projects one-by-one to avoid overwhelming the system and for better error tracking.
- **Action**: Add a **Split In Batches** node.
- **Batch Size**: `1`
- **Link**: Connect "Parse Discovery" to this node.

---

### Step 5: Dedupe Check (Code)
Checks if the project has already been submitted.
- **Action**: Add a **Code** node.
- **Code**:
  ```javascript
  const fs = require('fs');
  const dedupeFile = 'C:\\SpringBoot\\WorkSpace\\re-scraper\\submitted_projects_cache.json';
  
  let state = { projects: {} };
  if (fs.existsSync(dedupeFile)) {
    state = JSON.parse(fs.readFileSync(dedupeFile, 'utf8'));
  }
  
  const project = $json;
  const key = project.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  
  return { 
    ...project, 
    isDuplicate: !!state.projects[key]
  };
  ```

---

### Step 6: If Duplicate (If)
Branches based on whether the project is new.
- **Action**: Add an **If** node.
- **Condition**: `Boolean`
- **Value 1**: `={{$json.isDuplicate}}`
- **Operation**: `Is True`
- **Next**: Connect "False" output to the next step (Enrich).

---

### Step 7: Enrich Project (Execute Command)
Resolves IDs and prepares the final data.
- **Action**: Add an **Execute Command** node.
- **Command**:
  ```javascript
  // Use an expression for the command:
  ="cmd /c \"cd /d C:\\SpringBoot\\WorkSpace\\re-scraper && node scraper-modular.js --source=housing --task=enrich --data='" + JSON.stringify($json).replace(/'/g, "\\'") + "'\""
  ```

---

### Step 8: Parse Enriched (Code)
Parses the enrichment output.
- **Action**: Add a **Code** node.
- **Code**:
  ```javascript
  return JSON.parse($json.stdout);
  ```

---

### Step 9: Submit to API (HTTP Request)
The final submission step.
- **Action**: Add an **HTTP Request** node.
- **Method**: `POST`
- **URL**: `http://43.204.221.192:8880/api/re/projects`
- **Authentication**: (As required by your API)
- **Send Body**: `True`
- **Body Content Type**: `n8n Form Data` (or map the `formFields` object).
- **Parameters**: Map the fields from the previous node (e.g., `projectName`, `description`, etc.).

---

### Step 10: Feedback Loop
- **Done**: Connect the last node back to **Split In Batches** to process the next project.
