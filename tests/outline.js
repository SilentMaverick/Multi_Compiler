'use strict';

/**
 * Unit tests for the outline (function/class) parser.
 *   node tests/outline.js
 */

const { parse, flatten } = require('../public/outline.js');

let failures = 0;

function check(name, cond, detail) {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
}

function names(source) {
  return flatten(parse(source)).map((i) => `${i.kind}:${i.name}:${i.line}`);
}

// ---------------------------------------------------------------- C++
const CPP = `#include <iostream>

// int fake(int);  <- must be ignored, it is a comment
/* void alsoFake() { } */

class Calculator {
public:
    Calculator() : total_(0) {}
    int add(int a, int b) { return a + b; }
    void reset();
private:
    int total_;
};

struct Point {
    double x, y;
    double norm() const {
        return x * x + y * y;
    }
};

static int helper(int n)
{
    if (n > 0) {
        return n;
    }
    for (int i = 0; i < n; i++) { }
    return 0;
}

long long computeSum(const std::vector<int>& values,
                     int start,
                     int end)
{
    return 0;
}

int main() {
    Calculator c;
    int v = c.add(1, 2);
    std::cout << v << "\\n";
    return 0;
}
`;

const cpp = names(CPP);
console.log('=== C++ ===');
console.log('  ' + cpp.join('\n  '));

check('C++ finds classes', cpp.some((n) => n.startsWith('class:Calculator:')), cpp.join(', '));
check('C++ finds struct as class', cpp.some((n) => n.startsWith('class:Point:')), cpp.join(', '));
check('C++ finds constructor', cpp.some((n) => n === 'constructor:Calculator:8'), cpp.join(', '));
check('C++ finds method add', cpp.some((n) => n === 'function:add:9'), cpp.join(', '));
check('C++ finds method norm', cpp.some((n) => n === 'function:norm:17'), cpp.join(', '));
check('C++ finds free function helper', cpp.some((n) => n === 'function:helper:22'), cpp.join(', '));
check('C++ finds multi-line signature', cpp.some((n) => n === 'function:computeSum:31'), cpp.join(', '));
check('C++ finds main', cpp.some((n) => n === 'function:main:38'), cpp.join(', '));
check('C++ ignores comments', !cpp.some((n) => /fake/i.test(n)), cpp.join(', '));
check('C++ ignores control flow', !cpp.some((n) => /:(if|for|while):/.test(n)), cpp.join(', '));
check('C++ ignores declarations without body', !cpp.some((n) => n.includes(':reset:')), cpp.join(', '));

const cppTree = parse(CPP);
const known = cppTree.items.find((i) => i.name === 'Calculator');
check('C++ nests methods under the class', known && known.children.length === 2, known && known.children.map((c) => c.name));
check('C++ stats count', cppTree.stats.classes === 2 && cppTree.stats.functions >= 6, JSON.stringify(cppTree.stats));

// ---------------------------------------------------------------- Java
const JAVA = `import java.util.Scanner;

public class Main {
    private int count;

    public Main(int start) {
        this.count = start;
    }

    public static void main(String[] args) {
        Main m = new Main(5);
        if (m.count > 0) {
            System.out.println(m.describe());
        }
    }

    String describe() {
        return "count=" + count;
    }
}
`;

const java = names(JAVA);
console.log('\n=== Java ===');
console.log('  ' + java.join('\n  '));

check('Java finds class', java.some((n) => n.startsWith('class:Main:')), java.join(', '));
check('Java finds constructor', java.some((n) => n.startsWith('constructor:Main:6')), java.join(', '));
check('Java finds main', java.some((n) => n === 'function:main:10'), java.join(', '));
check('Java finds method describe', java.some((n) => n === 'function:describe:17'), java.join(', '));
check('Java ignores if/for', !java.some((n) => /:(if|for):/.test(n)), java.join(', '));

// ---------------------------------------------------------------- C
const C = `#include <stdio.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

static void push(Node **head, int v) {
    Node *n = malloc(sizeof(Node));
    n->value = v;
    n->next = *head;
    *head = n;
}

int main(void) {
    Node *head = NULL;
    push(&head, 1);
    return 0;
}
`;
const c = names(C);
console.log('\n=== C ===');
console.log('  ' + c.join('\n  '));
check('C finds typedef struct', c.some((n) => n.startsWith('class:Node:')), c.join(', '));
check('C finds push', c.some((n) => n === 'function:push:8'), c.join(', '));
check('C finds main', c.some((n) => n === 'function:main:15'), c.join(', '));

// ---------------------------------------------------------------- edge cases
console.log('\n=== edge cases ===');
check('empty source is safe', parse('').items.length === 0);
check('garbage does not throw', (() => {
  try {
    parse('}}}{{{ class if for ) ( int ;;;');
    return true;
  } catch {
    return false;
  }
})());
const single = parse('int twice(int x) { return x * 2; }');
check('one-line definition detected', single.items.length === 1 && single.items[0].name === 'twice', JSON.stringify(single.items));
const lambda = parse('auto f = [](int x) { return x; };');
check('lambda not reported as function', lambda.items.length === 0, JSON.stringify(lambda.items));

const filtered = flatten(parse(CPP)).filter((i) => i.name.toLowerCase().includes('calc'));
check('filtering works', filtered.length === 2, JSON.stringify(filtered.map((f) => f.name)));

console.log(`\n${failures ? `${failures} FAILED` : 'all outline checks passed'}`);
process.exit(failures ? 1 : 0);
