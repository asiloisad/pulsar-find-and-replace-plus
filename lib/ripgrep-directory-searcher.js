const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Custom ripgrep directory searcher with fixes for multiline patterns
// and Windows CRLF line endings.

function updateLeadingContext(message, pendingLeadingContext, options) {
  if (message.type !== "match" && message.type !== "context") {
    return;
  }

  if (options.leadingContextLineCount) {
    pendingLeadingContext.push(cleanResultLine(message.data.lines));

    if (pendingLeadingContext.length > options.leadingContextLineCount) {
      pendingLeadingContext.shift();
    }
  }
}

function updateTrailingContexts(message, pendingTrailingContexts, options) {
  if (message.type !== "match" && message.type !== "context") {
    return;
  }

  if (options.trailingContextLineCount) {
    for (const trailingContextLines of pendingTrailingContexts) {
      trailingContextLines.push(cleanResultLine(message.data.lines));

      if (trailingContextLines.length === options.trailingContextLineCount) {
        pendingTrailingContexts.delete(trailingContextLines);
      }
    }
  }
}

function cleanResultLine(resultLine) {
  resultLine = getText(resultLine);

  return resultLine[resultLine.length - 1] === "\n"
    ? resultLine.slice(0, -1)
    : resultLine;
}

function getPositionFromColumn(lines, column) {
  let currentLength = 0;
  let currentLine = 0;
  let previousLength = 0;

  while (column >= currentLength) {
    previousLength = currentLength;
    currentLength += lines[currentLine].length + 1;
    currentLine++;
  }

  return [currentLine - 1, column - previousLength];
}

function processUnicodeMatch(match) {
  // Fast path: if text is available directly and is ASCII-only, skip processing
  if ("text" in match.lines) {
    const text = match.lines.text;
    if (text.length === Buffer.byteLength(text)) {
      return;
    }
    // Has Unicode, need to convert byte offsets to character offsets
    processUnicodeOffsets(match.submatches, text);
  } else {
    // Base64 encoded, need to decode first
    const text = Buffer.from(match.lines.bytes, "base64").toString();
    if (text.length === Buffer.byteLength(text)) {
      return;
    }
    processUnicodeOffsets(match.submatches, text);
  }
}

function processUnicodeOffsets(submatches, text) {
  let remainingBuffer = Buffer.from(text);
  let currentLength = 0;
  let previousPosition = 0;

  function convertPosition(position) {
    const currentBuffer = remainingBuffer.slice(0, position - previousPosition);
    currentLength = currentBuffer.toString().length + currentLength;
    remainingBuffer = remainingBuffer.slice(position - previousPosition);
    previousPosition = position;
    return currentLength;
  }

  for (const submatch of submatches) {
    submatch.start = convertPosition(submatch.start);
    submatch.end = convertPosition(submatch.end);
  }
}

function processSubmatch(submatch, lineText, offsetRow) {
  const lineParts = lineText.split("\n");

  const start = getPositionFromColumn(lineParts, submatch.start);
  const end = getPositionFromColumn(lineParts, submatch.end);

  // Use slice instead of shift/pop mutations (O(1) vs O(n))
  const relevantParts = lineParts.slice(start[0], end[0] + 1);

  start[0] += offsetRow;
  end[0] += offsetRow;

  return {
    range: [start, end],
    lineText: cleanResultLine({ text: relevantParts.join("\n") }),
  };
}

function getText(input) {
  return "text" in input
    ? input.text
    : Buffer.from(input.bytes, "base64").toString();
}

module.exports = class RipgrepDirectorySearcher {
  canSearchDirectory() {
    // Only use this searcher when ripgrep is enabled
    return atom.config.get("search-panel.useRipgrep");
  }

  search(directories, regexp, options) {
    const numPathsFound = { num: 0 };

    const allPromises = directories.map((directory) =>
      this.searchInDirectory(directory, regexp, options, numPathsFound)
    );

    const promise = Promise.all(allPromises);

    promise.cancel = () => {
      for (const promise of allPromises) {
        promise.cancel();
      }
    };

    return promise;
  }

  searchInDirectory(directory, regexp, options, numPathsFound) {
    if (!this.rgPath) {
      // Find ripgrep binary from Pulsar's installation
      const resourcesPath =
        process.resourcesPath || path.dirname(require.main.filename);
      const rgBinary = process.platform === "win32" ? "rg.exe" : "rg";

      // Try multiple possible locations for ripgrep
      const possiblePaths = [
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "vscode-ripgrep",
          "bin",
          rgBinary
        ),
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "@vscode",
          "ripgrep",
          "bin",
          rgBinary
        ),
        path.join(
          resourcesPath,
          "node_modules",
          "vscode-ripgrep",
          "bin",
          rgBinary
        ),
        path.join(
          resourcesPath,
          "node_modules",
          "@vscode",
          "ripgrep",
          "bin",
          rgBinary
        ),
      ];

      for (const rgPath of possiblePaths) {
        if (fs.existsSync(rgPath)) {
          this.rgPath = rgPath;
          break;
        }
      }

      if (!this.rgPath) {
        throw new Error("Ripgrep binary not found");
      }
    }

    const directoryPath = directory.getPath();
    const regexpStr = this.prepareRegexp(regexp.source);

    const args = ["--json", "--regexp", regexpStr];
    if (options.leadingContextLineCount) {
      args.push("--before-context", options.leadingContextLineCount);
    }
    if (options.trailingContextLineCount) {
      args.push("--after-context", options.trailingContextLineCount);
    }
    if (regexp.ignoreCase) {
      args.push("--ignore-case");
    }
    for (const inclusion of this.prepareGlobs(
      options.inclusions,
      directoryPath
    )) {
      args.push("--glob", inclusion);
    }
    for (const exclusion of this.prepareGlobs(
      options.exclusions,
      directoryPath
    )) {
      args.push("--glob", "!" + exclusion);
    }

    if (this.isMultilineRegexp(regexpStr)) {
      args.push("--multiline");
    }

    // Always use --crlf for proper Windows line ending support (like VS Code)
    args.push("--crlf");

    if (options.includeHidden) {
      args.push("--hidden");
    }

    if (options.follow) {
      args.push("--follow");
    }

    if (!options.excludeVcsIgnores) {
      args.push("--no-ignore-vcs");
    }

    if (options.PCRE2) {
      args.push("--pcre2");
    }

    // Suppress error messages for files that can't be read (long paths, permissions, etc.)
    args.push("--no-messages");

    args.push(".");

    const child = spawn(this.rgPath, args, {
      cwd: directoryPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Close stdin immediately - ripgrep doesn't need input
    child.stdin.end();

    const didMatch = options.didMatch || (() => {});
    let cancelled = false;
    let matchCount = 0;

    const returnedPromise = new Promise((resolve, reject) => {
      let buffer = [];
      let bufferError = "";
      let pendingEvent;
      let pendingLeadingContext;
      let pendingTrailingContexts;

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        // If cancelled, resolve with "cancelled" so the model knows not to emit did-finish-searching
        if (cancelled) {
          resolve("cancelled");
          return;
        }

        // Exit codes: 0 = matches found, 1 = no matches, 2 = error (some files couldn't be read)
        // If we found matches, consider it a success even if some files had errors
        // Code 2 is informational (some files skipped) - not a real error
        if (code !== null && code > 2 && matchCount === 0) {
          const errorMsg = bufferError || `Search error (code ${code})`;
          reject(new Error(errorMsg));
        } else {
          resolve();
        }
      });

      child.stderr.on("data", (chunk) => {
        bufferError += chunk;
      });

      const processMessage = (message) => {
        updateTrailingContexts(message, pendingTrailingContexts, options);

        if (message.type === "begin") {
          pendingEvent = {
            filePath: path.join(directoryPath, getText(message.data.path)),
            matches: [],
          };
          pendingLeadingContext = [];
          pendingTrailingContexts = new Set();
        } else if (message.type === "match") {
          const trailingContextLines = [];
          pendingTrailingContexts.add(trailingContextLines);

          processUnicodeMatch(message.data);

          // Copy leading context once per match message, share among submatches
          const leadingContextLines = pendingLeadingContext.slice();
          const lineData = getText(message.data.lines);
          const lineNumber = message.data.line_number - 1;

          for (const submatch of message.data.submatches) {
            const { lineText, range } = processSubmatch(
              submatch,
              lineData,
              lineNumber
            );

            pendingEvent.matches.push({
              matchText: getText(submatch.match),
              lineText,
              lineTextOffset: 0,
              range,
              leadingContextLines,
              trailingContextLines,
            });
          }
        } else if (message.type === "end") {
          matchCount += pendingEvent.matches.length;
          options.didSearchPaths(++numPathsFound.num);
          didMatch(pendingEvent);
          pendingEvent = null;
        }

        updateLeadingContext(message, pendingLeadingContext, options);
      };

      child.stdout.on("data", (chunk) => {
        if (cancelled) {
          return;
        }

        // Use array buffering for better performance
        const chunkStr = chunk.toString();
        const newlineIdx = chunkStr.lastIndexOf("\n");

        if (newlineIdx === -1) {
          // No complete line yet, just buffer
          buffer.push(chunkStr);
          return;
        }

        // Process complete lines
        const beforeNewline = chunkStr.slice(0, newlineIdx);
        const afterNewline = chunkStr.slice(newlineIdx + 1);

        buffer.push(beforeNewline);
        const fullBuffer = buffer.join("");
        buffer = afterNewline ? [afterNewline] : [];

        const lines = fullBuffer.split("\n");
        for (const line of lines) {
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch (e) {
            // Skip malformed JSON lines (can happen with binary file detection edge cases)
            continue;
          }
          processMessage(message);
        }
      });
    });

    returnedPromise.cancel = () => {
      cancelled = true;
      if (process.platform === "win32") {
        // On Windows, child.kill() may not reliably terminate the process tree
        spawn("taskkill", ["/pid", child.pid, "/f", "/t"]);
      } else {
        child.kill("SIGKILL");
      }
    };

    return returnedPromise;
  }

  prepareGlobs(globs, projectRootPath) {
    const output = [];

    if (!globs || !Array.isArray(globs)) {
      return output;
    }

    const projectName = path.basename(projectRootPath);
    const sepRegex = new RegExp(`\\${path.sep}`, "g");

    for (let pattern of globs) {
      pattern = pattern.replace(sepRegex, "/");

      if (pattern.length === 0) {
        continue;
      }

      if (pattern === projectName) {
        output.push("**/*");
        continue;
      }

      if (pattern.startsWith(projectName + "/")) {
        pattern = pattern.slice(projectName.length + 1);
      }

      if (pattern.endsWith("/")) {
        pattern = pattern.slice(0, -1);
      }

      // If pattern already ends with /** or /*, no need to duplicate
      if (pattern.endsWith("/**") || pattern.endsWith("/*")) {
        output.push(pattern);
      } else if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
        // Pattern has glob chars - use as-is (e.g., *.js, test?.txt)
        output.push(pattern);
      } else {
        // Plain name could be file or directory - add both patterns
        output.push(pattern);
        output.push(`${pattern}/**`);
      }
    }

    return output;
  }

  prepareRegexp(regexpStr) {
    if (regexpStr === "--") {
      return "\\-\\-";
    }

    regexpStr = regexpStr.replace(/\\\//g, "/");

    // Rewrite \n to \r?\n so it matches both CRLF and LF line endings (like VS Code).
    // Use negative lookbehinds to avoid replacing \n that's already part of \r\n or \r?\n.
    regexpStr = regexpStr.replace(/(?<!\\r\?)(?<!\\r)\\n/g, "\\r?\\n");

    return regexpStr;
  }

  isMultilineRegexp(regexpStr) {
    // Check for both \n and \r to properly detect multiline patterns
    if (regexpStr.includes("\\n") || regexpStr.includes("\\r")) {
      return true;
    }
    return false;
  }
};
