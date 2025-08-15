/**
 * @description A Figma plugin to streamline design workflows by:
 * 1. Renaming text layers to match a predefined naming convention based on their text style.
 * 2. Renaming default frame names (e.g., "Frame 1") to "item".
 * 3. Identifying and selecting text layers that use an incorrect color style or variable.
 *
 * @see {@link https://www.figma.com/plugin-docs/api/api-overview/|Figma Plugin API}
 */

// Show a hidden UI. This is required for the plugin to run in the background,
// especially for asynchronous operations that might take time to complete.
figma.showUI(__html__, { visible: false });

/**
 * Recursively finds all text nodes within a given node.
 * @param {SceneNode} node The node to search within.
 * @returns {TextNode[]} An array of all found text nodes.
 */
function findAllTextNodes(node) {
  // Ignore hidden nodes and their children.
  if (!node.visible) {
    return [];
  }

  let textNodes = [];
  if (node.type === "TEXT") {
    textNodes.push(node);
  } else if ("children" in node) {
    for (const child of node.children) {
      textNodes = textNodes.concat(findAllTextNodes(child));
    }
  }
  return textNodes;
}

// Recursively rename all frames with default Figma names to 'item'
function renameDefaultFramesRecursively(node) {
  const defaultFrameNameRegex = /^Frame( \d+)?$/;
  if (node.type === "FRAME" && defaultFrameNameRegex.test(node.name)) {
    node.name = "item";
  }
  if ("children" in node) {
    for (const child of node.children) {
      renameDefaultFramesRecursively(child);
    }
  }
}

// --- Style & Color Mappings ---
// Dynamically generate style mappings to make the configuration scalable and easier to maintain.
// This object maps a style category (e.g., "heading") to a new layer name and a set of valid color styles.
const styleCategories = {};
const categories = {
  "heading": "heading-text",
  "title": "title-text",
  "subtitle": "subtitle-text",
  "body": "body-text",
  "highlighted": "highlighted-text",
  "info": "info-text",
  "caption": "caption-text",
  "overline": "overline-text"
};

const colorPaths = {
  regular: "colors/content/text/regular/",
  inverse: "colors/content/text/inverse/",
  brand: "colors/content/text/brand/"
};

// These state colors are considered valid for any text style and will be ignored during the mismatch check.
const stateColors = new Set([
  "colors/state/info",
  "colors/state/success",
  "colors/state/warning",
  "colors/state/error",
  "colors/content/text/regular/disabled"
]);

for (const category in categories) {
  const newName = categories[category];
  let colorSet;

  if (category === "highlighted") {
    colorSet = [
      `${colorPaths.brand}${category}`,
      `${colorPaths.inverse}${category}`
    ];
  } else {
    colorSet = [
      `${colorPaths.regular}${category}`,
      `${colorPaths.inverse}${category}`
    ];
  }
  
  styleCategories[category] = {
    newName: newName,
    color: colorSet
  };
}

/**
 * The main function that orchestrates the renaming and color-checking process.
 */
async function renameAndCheckColors() {
  // 1. Get the user's current selection and validate it.
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.notify("Please select at least one frame or text layer.");
    figma.closePlugin();
    return;
  }

  // 2. Recursively rename default frame names (e.g., "Frame 1") to "item".
  let frameRenamedCount = 0;
  function renameDefaultFramesRecursivelyWithCount(node) {
    // Ignore hidden nodes and their children.
    if (!node.visible) {
      return;
    }
    
    const defaultFrameNameRegex = /^Frame( \d+)?$/;
    if (node.type === "FRAME" && defaultFrameNameRegex.test(node.name)) {
      node.name = "item";
      frameRenamedCount++;
    }
    if ("children" in node) {
      for (const child of node.children) {
        renameDefaultFramesRecursivelyWithCount(child);
      }
    }
  }
  for (const node of selection) {
    renameDefaultFramesRecursivelyWithCount(node);
  }
  // --- END NEW FEATURE ---

  // 3. Find all text nodes within the selection.
  let nodesToCheck = [];
  for (const node of selection) {
    if (node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "SECTION") {
      nodesToCheck = nodesToCheck.concat(findAllTextNodes(node));
    } else if (node.type === "TEXT") {
      nodesToCheck.push(node);
    }
  }

  if (nodesToCheck.length === 0) {
    figma.notify("No text layers found in selection.");
    figma.closePlugin();
    return;
  }

  // 4. First pass (synchronous): Rename layers and identify nodes for color checking.
  // This pass is fast and handles layer renaming and caches style information.
  let renamedCount = 0;
  let mismatchedNodes = [];
  const total = nodesToCheck.length;
  let startTime = Date.now();
  
  const nodesForColorCheck = [];
  const styleCache = new Map();
  let processed = 0;

  for (const textNode of nodesToCheck) {
    processed++;

    if (textNode.textStyleId && typeof textNode.textStyleId === 'string') {
      let style = styleCache.get(textNode.textStyleId);
      if (style === undefined) {
        style = figma.getStyleById(textNode.textStyleId);
        styleCache.set(textNode.textStyleId, style);
      }

      if (style && style.type === "TEXT") {
        const category = style.name.split('/')[0];
        const mapping = styleCategories[category];

        if (mapping) {
          if (textNode.name !== mapping.newName) {
            textNode.name = mapping.newName;
            renamedCount++;
          }
          nodesForColorCheck.push({ textNode, mapping });
        }
      }
    }
  }

  // 5. Second pass (asynchronous): Verify colors for the collected nodes.
  // This runs all async color checks in parallel for better performance.
  if (nodesForColorCheck.length > 0) {
    const colorCheckPromises = nodesForColorCheck.map(async ({ textNode, mapping }) => {
      let isColorCorrect = false;
      const expectedColors = Array.isArray(mapping.color) ? mapping.color : [mapping.color];

      if (textNode.boundVariables && textNode.boundVariables['fills'] && textNode.boundVariables['fills'].length > 0) {
        const variableId = textNode.boundVariables['fills'][0].id;
        try {
          const variable = await figma.variables.getVariableByIdAsync(variableId);
          if (variable) {
            // A color is correct if it's in the expected set for the style OR if it's a globally valid state color.
            if (expectedColors.includes(variable.name) || stateColors.has(variable.name)) {
              isColorCorrect = true;
            }
          }
        } catch (error) {
          console.error(`Error fetching variable ${variableId}:`, error);
        }
      } else if (textNode.fillStyleId && typeof textNode.fillStyleId === 'string') {
        let fillStyle = styleCache.get(textNode.fillStyleId);
        if (fillStyle === undefined) {
          fillStyle = figma.getStyleById(textNode.fillStyleId);
          styleCache.set(textNode.fillStyleId, fillStyle);
        }
        
        if (fillStyle) {
          // A color is correct if it's in the expected set for the style OR if it's a globally valid state color.
          if (expectedColors.includes(fillStyle.name) || stateColors.has(fillStyle.name)) {
            isColorCorrect = true;
          }
        }
      }

      if (!isColorCorrect) {
        return textNode;
      }
      return null;
    });

    const results = await Promise.all(colorCheckPromises);
    mismatchedNodes = results.filter(node => node !== null);
  }

  // 6. Generate a summary and notify the user.
  // This selects mismatched layers so the user can easily find and fix them.
  let summaryParts = [];
  if (frameRenamedCount > 0) {
    summaryParts.push(`${frameRenamedCount} frame layer${frameRenamedCount === 1 ? '' : 's'} renamed to 'item'`);
  }
  if (renamedCount > 0) {
    summaryParts.push(`${renamedCount} text layer${renamedCount === 1 ? '' : 's'} renamed`);
  }
  if (mismatchedNodes.length > 0) {
    summaryParts.push(`${mismatchedNodes.length} mismatched layer${mismatchedNodes.length === 1 ? '' : 's'} selected`);
    figma.currentPage.selection = mismatchedNodes;
    figma.viewport.scrollAndZoomIntoView(mismatchedNodes);
  }
  if (summaryParts.length === 0) {
    summaryParts.push('✨ Everything is perfect');
  }
  figma.notify(summaryParts.join('; ') + '.', { timeout: 5000 });
  figma.closePlugin();
}

// Handles messages from a UI, if one were to be implemented.
figma.ui.onmessage = (msg) => {
  if (msg.type === 'rename-and-check') {
    renameAndCheckColors();
  }
};

// Immediately run the main function when the plugin starts.
renameAndCheckColors();