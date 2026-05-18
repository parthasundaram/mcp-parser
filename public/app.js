const form = document.querySelector("#inspectForm");
const urlInput = document.querySelector("#serverUrl");
const button = document.querySelector("#inspectButton");
const statusPill = document.querySelector("#statusPill");
const results = document.querySelector("#results");
const emptyState = document.querySelector("#emptyState");
const metaBar = document.querySelector("#metaBar");
const transportValue = document.querySelector("#transportValue");
const protocolValue = document.querySelector("#protocolValue");
const toolCountValue = document.querySelector("#toolCountValue");
const toolTemplate = document.querySelector("#toolTemplate");

const typeLabel = (schema = {}) => {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type) return schema.type;
  if (schema.anyOf) return schema.anyOf.map(typeLabel).join(" | ");
  if (schema.oneOf) return schema.oneOf.map(typeLabel).join(" | ");
  if (schema.enum) return "enum";
  return "value";
};

const formatDefault = (value) => {
  if (value === undefined) return "";
  if (typeof value === "string") return `"${value}"`;
  return JSON.stringify(value);
};

function setStatus(label, mode = "idle") {
  statusPill.textContent = label;
  statusPill.dataset.mode = mode;
}

function setLoading(isLoading) {
  button.disabled = isLoading;
  urlInput.disabled = isLoading;
  button.querySelector("span").textContent = isLoading ? "Inspecting" : "Inspect";
}

function clearResults() {
  results.innerHTML = "";
}

function renderError(message) {
  clearResults();
  metaBar.hidden = true;
  const block = document.createElement("div");
  block.className = "error-state";
  block.innerHTML = `
    <h2>Could not inspect that server</h2>
    <p></p>
  `;
  block.querySelector("p").textContent = message;
  results.append(block);
}

function renderObjectSchema(schema, required = []) {
  const properties = schema?.properties || {};
  const entries = Object.entries(properties);

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "no-params";
    empty.textContent = "No input parameters.";
    return empty;
  }

  const list = document.createElement("div");
  list.className = "param-list";

  for (const [name, property] of entries) {
    const row = document.createElement("div");
    row.className = "param-row";

    const title = document.createElement("div");
    title.className = "param-title";

    const nameNode = document.createElement("strong");
    nameNode.textContent = name;
    title.append(nameNode);

    const typeNode = document.createElement("span");
    typeNode.textContent = typeLabel(property);
    title.append(typeNode);

    if (required.includes(name)) {
      const requiredNode = document.createElement("em");
      requiredNode.textContent = "required";
      title.append(requiredNode);
    }

    row.append(title);

    if (property.description) {
      const description = document.createElement("p");
      description.textContent = property.description;
      row.append(description);
    }

    const details = [];
    if (property.enum) details.push(`Allowed: ${property.enum.join(", ")}`);
    if (property.default !== undefined) details.push(`Default: ${formatDefault(property.default)}`);
    if (property.items) details.push(`Items: ${typeLabel(property.items)}`);

    if (details.length) {
      const detailNode = document.createElement("small");
      detailNode.textContent = details.join(" · ");
      row.append(detailNode);
    }

    if (property.properties) {
      const nested = renderObjectSchema(property, property.required || []);
      nested.classList.add("nested");
      row.append(nested);
    }

    list.append(row);
  }

  return list;
}

function renderTools(payload) {
  clearResults();

  const tools = payload.tools || [];
  metaBar.hidden = false;
  transportValue.textContent = payload.transport || "-";
  protocolValue.textContent = payload.protocolVersion || "-";
  toolCountValue.textContent = String(tools.length);

  if (!tools.length) {
    const block = document.createElement("div");
    block.className = "empty-state";
    block.innerHTML = `
      <h2>No tools returned</h2>
      <p>The server responded successfully, but its tools/list result was empty.</p>
    `;
    results.append(block);
    return;
  }

  for (const tool of tools) {
    const card = toolTemplate.content.firstElementChild.cloneNode(true);
    const schema = tool.inputSchema || {};
    const required = schema.required || [];
    const propertyCount = Object.keys(schema.properties || {}).length;

    card.querySelector(".tool-name").textContent = tool.name || "Unnamed tool";
    card.querySelector(".tool-description").textContent =
      tool.description || "No description provided.";
    card.querySelector(".param-count").textContent =
      propertyCount === 1 ? "1 parameter" : `${propertyCount} parameters`;
    card.querySelector(".schema-wrap").append(renderObjectSchema(schema, required));

    results.append(card);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  setLoading(true);
  setStatus("Connecting", "loading");
  clearResults();
  results.append(emptyState.cloneNode(true));
  results.querySelector(".empty-state h2").textContent = "Inspecting server";
  results.querySelector(".empty-state p").textContent =
    "Negotiating the MCP session and asking for tools/list.";

  try {
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urlInput.value.trim() }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "The server could not be inspected.");
    }

    renderTools(payload);
    setStatus("Connected", "success");
  } catch (error) {
    renderError(error.message);
    setStatus("Error", "error");
  } finally {
    setLoading(false);
  }
});
