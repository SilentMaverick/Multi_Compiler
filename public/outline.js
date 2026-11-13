/* Outline parser: extracts classes, functions and methods from C, C++ and Java.
 *
 * This is a heuristic scanner, not a real parser - it strips comments and string
 * literals, tracks brace depth, then recognises class-like and function-like
 * definitions at each depth. Good enough for navigation on normal code, and it
 * never throws on malformed input.
 *
 * Works in the browser (window.MCOutline) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCOutline = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTROL = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'sizeof',
    'decltype', 'alignof', 'static_assert', 'throw', 'new', 'delete', 'case',
    'default', 'try', 'using', 'typedef', 'namespace', 'operator',
  ]);

  var CLASS_KINDS = new Set(['class', 'struct', 'enum', 'union', 'interface', 'record']);

  var KEYWORDS_BEFORE = /^(?:public|private|protected|internal|abstract|final|static|sealed|partial|virtual|inline|explicit|constexpr|consteval|constinit|friend|extern|template|native|synchronized|default|transient|volatile|register|mutable)\s+/;

  /** Blank out comments and string/char literals while preserving line structure. */
  function stripNoise(src) {
    var out = '';
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src[i];
      var d = src[i + 1];

      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') {
          out += ' ';
          i++;
        }
        continue;
      }
      if (c === '/' && d === '*') {
        out += '  ';
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        var quote = c;
        out += ' ';
        i++;
        while (i < n && src[i] !== quote) {
          if (src[i] === '\\' && i + 1 < n) {
            out += '  ';
            i += 2;
            continue;
          }
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        out += ' ';
        i++;
        continue;
      }
      // raw strings are rare in teaching code; treat them as normal text
      out += c;
      i++;
    }
    return out;
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  /** Pull "class Foo" / "interface Bar" out of a line. */
  function matchClass(text) {
    var m = /^\s*((?:(?:public|private|protected|internal|abstract|final|static|sealed|partial|export)\s+)*)(class|struct|enum|union|interface|record)\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (!m) return null;
    if (!CLASS_KINDS.has(m[2])) return null;
    var trailing = text.slice(m.index + m[0].length);
    // "enum class" already covered; ignore forward declarations ("class Foo;")
    if (/^\s*;/.test(trailing)) return null;
    return { kind: 'class', keyword: m[2], name: m[3] };
  }

  /**
   * Decide whether the joined text starts a function definition.
   * @returns {{name:string, signature:string, isCall:boolean}|null}
   */
  function matchFunction(text) {
    var t = normalize(text);
    if (!t) return null;
    if (t[0] === '[' ) return null; // lambda capture
    if (KEYWORDS_BEFORE.test(t) && /^(?:template)\s*</.test(t)) return null;

    // The identifier right before the parameter list, plus the balanced parens.
    var open = t.indexOf('(');
    if (open < 0) return null;
    // Skip parens inside "operator()" style names only when they are the name itself.
    var head = t.slice(0, open).trim();
    if (!head) return null;

    var nameMatch = /([A-Za-z_$~][\w$]*|~[A-Za-z_$][\w$]*)\s*$/.exec(head);
    if (!nameMatch) return null;
    var name = nameMatch[1];

    // A qualified name (Foo::bar) is fine; keep the simple part as the label.
    var plain = name.replace(/^~/, '').replace(/.*::/, '');
    if (CONTROL.has(plain)) return null;

    // Reject obvious statements: "foo(1);" has no body marker after the parens.
    var close = t.lastIndexOf(')');
    if (close < open) return null;
    var tail = t.slice(close + 1);
    var hasBody = /\{/.test(tail) || /\{/.test(t.slice(close));
    // If there is no brace at all it may still be a definition whose brace is on
    // the next line - the caller decides that; here we require a plausible shape.
    if (!hasBody) {
      // "int f(int);"  -> declaration, skip.  "int f(int)" -> maybe brace follows.
      if (/;\s*$/.test(t)) return null;
      return { name: plain, signature: buildSignature(head, name, t, open, close), isCall: true };
    }

    return { name: plain, signature: buildSignature(head, name, t, open, close), isCall: false };
  }

  function buildSignature(head, name, text, open, close) {
    var ret = head.slice(0, head.length - name.length).trim();
    ret = ret.replace(KEYWORDS_BEFORE, '').replace(/^(?:virtual|inline|static|public|private|protected|final|abstract)\s+/g, '').trim();
    var params = text.slice(open + 1, close);
    params = normalize(params);
    if (params.length > 60) params = params.slice(0, 57) + '...';
    return { ret: ret, params: params };
  }

  /**
   * @param {string} source
   * @returns {{items: Array, stats: {functions:number, classes:number, lines:number}}}
   */
  function parse(source) {
    var text = stripNoise(String(source || ''));
    var rawLines = String(source || '').split(/\r?\n/);
    var lines = text.split(/\r?\n/);

    var items = [];
    var stack = []; // open class-like containers
    var depth = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      if (/^\s*#/.test(line)) continue; // preprocessor

      var depthBefore = depth;

      // close containers whose body has ended
      while (stack.length && depthBefore <= stack[stack.length - 1].depth) {
        stack.pop();
      }

      var cls = matchClass(line);
      if (cls) {
        var container = {
          kind: 'class',
          subkind: cls.keyword,
          name: cls.name,
          line: i + 1,
          depth: depthBefore,
          signature: normalize(line).replace(/\s*\{?\s*$/, ''),
          children: [],
        };
        var parent = stack[stack.length - 1];
        if (parent && parent.depth < depthBefore) {
          container.parent = parent.name;
          parent.children.push(container);
        } else items.push(container);
        // Only treat it as a container if it actually opens a body on this line.
        if (/\{/.test(line)) {
          stack.push(container);
        } else {
          // brace may open on the next line; peek
          var j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && /^\s*\{/.test(lines[j])) stack.push(container);
        }
      } else {
        var joined = line;
        var consumed = 0;
        // join continuation lines while the parameter list is unbalanced
        var balance = countParens(joined);
        while (balance > 0 && consumed < 4 && i + consumed + 1 < lines.length) {
          consumed++;
          joined += ' ' + lines[i + consumed];
          balance = countParens(joined);
        }

        var fn = matchFunction(joined);
        if (fn) {
          var bodyHere = /\{/.test(joined);
          var nextOpensBrace = false;
          if (!bodyHere) {
            var k = i + consumed + 1;
            while (k < lines.length && !lines[k].trim()) k++;
            if (k < lines.length) nextOpensBrace = /^\s*\{/.test(lines[k]);
          }

          // a call with a following brace ("foo(x)\n{") would be a false positive,
          // but that shape is almost always a definition, so accept it.
          if (!fn.isCall || nextOpensBrace) {
            var owner = stack[stack.length - 1];
            var node = {
              kind: owner && plainName(owner.name) === fn.name ? 'constructor' : 'function',
              name: fn.name,
              line: i + 1,
              depth: depthBefore,
              signature: formatSignature(fn.signature, fn.name),
              children: [],
            };
            if (owner && owner.depth < depthBefore) {
              node.parent = owner.name;
              owner.children.push(node);
            } else items.push(node);
          }
        }
      }

      depth += countBraces(line);
      if (depth < 0) depth = 0;
    }

    var stats = { functions: 0, classes: 0, lines: rawLines.length };
    (function count(list) {
      list.forEach(function (item) {
        if (item.kind === 'class') stats.classes++;
        else stats.functions++;
        count(item.children);
      });
    })(items);

    return { items: items, stats: stats };
  }

  function plainName(name) {
    return String(name).replace(/^~/, '').replace(/[\s<].*$/, '').replace(/.*::/, '');
  }

  function formatSignature(sig, name) {
    var params = sig.params ? '(' + sig.params + ')' : '()';
    var ret = sig.ret ? sig.ret + ' ' : '';
    return normalize(ret + name + params);
  }

  function countParens(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '(') n++;
      else if (text[i] === ')') n--;
    }
    return n;
  }

  function countBraces(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '{') n++;
      else if (text[i] === '}') n--;
    }
    return n;
  }

  /** Flatten to a list with indent levels, for easy rendering/filtering. */
  function flatten(result) {
    var out = [];
    (function walk(list, level) {
      list.forEach(function (item) {
        out.push({
          kind: item.kind,
          subkind: item.subkind,
          name: item.name,
          line: item.line,
          level: level,
          signature: item.signature,
          parent: item.parent || null,
        });
        walk(item.children || [], level + 1);
      });
    })(result.items, 0);
    return out;
  }

  return { parse: parse, flatten: flatten, stripNoise: stripNoise };
});
