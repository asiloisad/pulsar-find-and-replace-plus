const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Custom ripgrep directory searcher with fixes for multiline patterns
// and Windows CRLF line endings.

function updateLeadingContext(message, pendingLeadingContext, options) {
  if (message.type !== 'match' && message.type !== 'context') {
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
  if (message.type !== 'match' && message.type !== 'context') {
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

  return resultLine[resultLine.length - 1] === '\n'
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
  const text = getText(match.lines);

  if (text.length === Buffer.byteLength(text)) {
    return;
  }

  let remainingBuffer = Buffer.from(text);
  let currentLength = 0;
  let previousPosition = 0;

  function convertPosition(position) {
    const currentBuffer = remainingBuffer.slice(0, position - previousPosition);
    currentLength = currentBuffer.toString().length + currentLength;
    remainingBuffer = remainingBuffer.slice(position);

    previousPosition = position;

    return currentLength;
  }

  for (const submatch of match.submatches) {
    submatch.start = convertPosition(submatch.start);
    submatch.end = convertPosition(submatch.end);
  }
}

function processSubmatch(submatch, lineText, offsetRow) {
  const lineParts = lineText.split('\n');

  const start = getPositionFromColumn(lineParts, submatch.start);
  const end = getPositionFromColumn(lineParts, submatch.end);

  for (let i = start[0]; i > 0; i--) {
    lineParts.shift();
  }
  while (end[0] < lineParts.length - 1) {
    lineParts.pop();
  }

  start[0] += offsetRow;
  end[0] += offsetRow;

  return {
    range: [start, end],
    lineText: cleanResultLine({ text: lineParts.join('\n') })
  };
}

function getText(input) {
  return 'text' in input
    ? input.text
    : Buffer.from(input.bytes, 'base64').toString();
}

module.exports = class RipgrepDirectorySearcher {
  canSearchDirectory(directory) {
    // Only use this searcher when ripgrep is enabled
    return atom.config.get('find-and-replace-plus.useRipgrep');
  }

  search(directories, regexp, options) {
    const numPathsFound = { num: 0 };

    const allPromises = directories.map(directory =>
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
      const resourcesPath = process.resourcesPath || path.dirname(require.main.filename);
      const rgBinary = process.platform === 'win32' ? 'rg.exe' : 'rg';

      // Try multiple possible locations for ripgrep
      const possiblePaths = [
        path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'vscode-ripgrep', 'bin', rgBinary),
        path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', rgBinary),
        path.join(resourcesPath, 'node_modules', 'vscode-ripgrep', 'bin', rgBinary),
        path.join(resourcesPath, 'node_modules', '@vscode', 'ripgrep', 'bin', rgBinary),
      ];

      for (const rgPath of possiblePaths) {
        if (fs.existsSync(rgPath)) {
          this.rgPath = rgPath;
          break;
        }
      }

      if (!this.rgPath) {
        throw new Error('Ripgrep binary not found');
      }
    }

    const directoryPath = directory.getPath();
    const regexpStr = this.prepareRegexp(regexp.source);

    const args = ['--json', '--regexp', regexpStr];
    if (options.leadingContextLineCount) {
      args.push('--before-context', options.leadingContextLineCount);
    }
    if (options.trailingContextLineCount) {
      args.push('--after-context', options.trailingContextLineCount);
    }
    if (regexp.ignoreCase) {
      args.push('--ignore-case');
    }
    for (const inclusion of this.prepareGlobs(
      options.inclusions,
      directoryPath
    )) {
      args.push('--glob', inclusion);
    }
    for (const exclusion of this.prepareGlobs(
      options.exclusions,
      directoryPath
    )) {
      args.push('--glob', '!' + exclusion);
    }

    if (this.isMultilineRegexp(regexpStr)) {
      args.push('--multiline');
    }

    // Always use --crlf for proper Windows line ending support (like VS Code)
    args.push('--crlf');

    if (options.includeHidden) {
      args.push('--hidden');
    }

    if (options.follow) {
      args.push('--follow');
    }

    if (!options.excludeVcsIgnores) {
      args.push('--no-ignore-vcs');
    }

    if (options.PCRE2) {
      args.push('--pcre2');
    }

    // Suppress error messages for files that can't be read (long paths, permissions, etc.)
    args.push('--no-messages');

    args.push('.');

    const child = spawn(this.rgPath, args, {
      cwd: directoryPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const didMatch = options.didMatch || (() => {});
    let cancelled = false;
    let matchCount = 0;

    const returnedPromise = new Promise((resolve, reject) => {
      let buffer = '';
      let bufferError = '';
      let pendingEvent;
      let pendingLeadingContext;
      let pendingTrailingContexts;

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code, signal) => {
        // Exit codes: 0 = matches found, 1 = no matches, 2 = error (some files couldn't be read)
        // If we found matches, consider it a success even if some files had errors
        if (code !== null && code > 1 && matchCount === 0) {
          reject(new Error(bufferError || `Ripgrep exited with code ${code}`));
        } else {
          resolve();
        }
      });

      child.stderr.on('data', chunk => {
        bufferError += chunk;
      });

      child.stdout.on('data', chunk => {
        if (cancelled) {
          return;
        }

        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const message = JSON.parse(line);
          updateTrailingContexts(message, pendingTrailingContexts, options);

          if (message.type === 'begin') {
            pendingEvent = {
              filePath: path.join(directoryPath, getText(message.data.path)),
              matches: []
            };
            pendingLeadingContext = [];
            pendingTrailingContexts = new Set();
          } else if (message.type === 'match') {
            const trailingContextLines = [];
            pendingTrailingContexts.add(trailingContextLines);

            processUnicodeMatch(message.data);

            for (const submatch of message.data.submatches) {
              const { lineText, range } = processSubmatch(
                submatch,
                getText(message.data.lines),
                message.data.line_number - 1
              );

              pendingEvent.matches.push({
                matchText: getText(submatch.match),
                lineText,
                lineTextOffset: 0,
                range,
                leadingContextLines: [...pendingLeadingContext],
                trailingContextLines
              });
            }
          } else if (message.type === 'end') {
            matchCount += pendingEvent.matches.length;
            options.didSearchPaths(++numPathsFound.num);
            didMatch(pendingEvent);
            pendingEvent = null;
          }

          updateLeadingContext(message, pendingLeadingContext, options);
        }
      });
    });

    returnedPromise.cancel = () => {
      child.kill();
      cancelled = true;
    };

    return returnedPromise;
  }

  prepareGlobs(globs, projectRootPath) {
    const output = [];

    if (!globs || !Array.isArray(globs)) {
      return output;
    }

    for (let pattern of globs) {
      pattern = pattern.replace(new RegExp(`\\${path.sep}`, 'g'), '/');

      if (pattern.length === 0) {
        continue;
      }

      const projectName = path.basename(projectRootPath);

      if (pattern === projectName) {
        output.push('**/*');
        continue;
      }

      if (pattern.startsWith(projectName + '/')) {
        pattern = pattern.slice(projectName.length + 1);
      }

      if (pattern.endsWith('/')) {
        pattern = pattern.slice(0, -1);
      }

      output.push(pattern);
      output.push(pattern.endsWith('/**') ? pattern : `${pattern}/**`);
    }

    return output;
  }

  prepareRegexp(regexpStr) {
    if (regexpStr === '--') {
      return '\\-\\-';
    }

    regexpStr = regexpStr.replace(/\\\//g, '/');

    // Rewrite \n to \r?\n so it matches both CRLF and LF line endings (like VS Code).
    // Use negative lookbehinds to avoid replacing \n that's already part of \r\n or \r?\n.
    regexpStr = regexpStr.replace(/(?<!\\r\?)(?<!\\r)\\n/g, '\\r?\\n');

    return regexpStr;
  }

  isMultilineRegexp(regexpStr) {
    // Check for both \n and \r to properly detect multiline patterns
    if (regexpStr.includes('\\n') || regexpStr.includes('\\r')) {
      return true;
    }
    return false;
  }
};
