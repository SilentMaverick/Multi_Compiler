'use strict';

/**
 * Starter programs. Kept in one place so the UI and the docs cannot drift apart.
 */

const CPP_HELLO = `#include <iostream>
#include <string>
#include <vector>

int main() {
    std::string name;
    if (!(std::cin >> name)) name = "world";

    std::vector<int> squares;
    for (int i = 1; i <= 5; ++i) squares.push_back(i * i);

    std::cout << "Hello, " << name << "!\\n";
    std::cout << "Squares:";
    for (int s : squares) std::cout << ' ' << s;
    std::cout << '\\n';
    return 0;
}
`;

const CPP_STDIN = `#include <iostream>
#include <vector>

int main() {
    int n = 0;
    if (!(std::cin >> n)) return 0;

    std::vector<long long> a(n);
    long long best = 0;
    long long running = 0;
    for (int i = 0; i < n; ++i) {
        std::cin >> a[i];
        running = running > 0 ? running + a[i] : a[i];
        if (running > best) best = running;
    }
    std::cout << best << '\\n';
    return 0;
}
`;

const JAVA_HELLO = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String name = sc.hasNext() ? sc.next() : "world";

        StringBuilder sb = new StringBuilder("Hello, ").append(name).append("!\\n");
        sb.append("Squares:");
        for (int i = 1; i <= 5; i++) {
            sb.append(' ').append(i * i);
        }
        System.out.println(sb);
    }
}
`;

const JAVA_MULTI = `public class Main {
    public static void main(String[] args) {
        System.out.println(Greeter.greet("Java"));
        System.out.println("2 + 3 = " + Calculator.add(2, 3));
    }
}
`;

const JAVA_MULTI_GREETER = `public class Greeter {
    public static String greet(String who) {
        return "Hello from " + who + "!";
    }
}
`;

const JAVA_MULTI_CALC = `public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;

const PYTHON_HELLO = `import sys

name = sys.stdin.readline().strip() or "world"
squares = [i * i for i in range(1, 6)]

print(f"Hello, {name}!")
print("Squares:", *squares)
`;

const JS_HELLO = `const data = require('fs').readFileSync(0, 'utf8').trim();
const name = data.split(/\\s+/)[0] || 'world';

const squares = [1, 2, 3, 4, 5].map((i) => i * i);
console.log(\`Hello, \${name}!\`);
console.log('Squares:', ...squares);
`;

const examples = [
  {
    id: 'cpp-hello',
    label: 'C++  hello + stdin',
    language: 'cpp',
    files: [{ name: 'main.cpp', content: CPP_HELLO }],
    stdin: 'coder\n',
  },
  {
    id: 'cpp-kadane',
    label: 'C++  max subarray (test cases)',
    language: 'cpp',
    files: [{ name: 'main.cpp', content: CPP_STDIN }],
    stdin: '8\n-2 1 -3 4 -1 2 1 -5\n',
    tests: [
      { input: '8\n-2 1 -3 4 -1 2 1 -5\n', expected: '6\n' },
      { input: '3\n-5 -2 -9\n', expected: '-2\n' },
      { input: '1\n7\n', expected: '7\n' },
    ],
  },
  {
    id: 'java-hello',
    label: 'Java  hello + stdin',
    language: 'java',
    files: [{ name: 'Main.java', content: JAVA_HELLO }],
    stdin: 'coder\n',
  },
  {
    id: 'java-multi',
    label: 'Java  multi-class project',
    language: 'java',
    files: [
      { name: 'Main.java', content: JAVA_MULTI },
      { name: 'Greeter.java', content: JAVA_MULTI_GREETER },
      { name: 'Calculator.java', content: JAVA_MULTI_CALC },
    ],
    stdin: '',
  },
  {
    id: 'python-hello',
    label: 'Python  hello + stdin',
    language: 'python',
    files: [{ name: 'main.py', content: PYTHON_HELLO }],
    stdin: 'coder\n',
  },
  {
    id: 'js-hello',
    label: 'JavaScript  hello + stdin',
    language: 'javascript',
    files: [{ name: 'main.js', content: JS_HELLO }],
    stdin: 'coder\n',
  },
];

function list() {
  return examples;
}

function byId(id) {
  return examples.find((e) => e.id === id) || null;
}

module.exports = { list, byId };
