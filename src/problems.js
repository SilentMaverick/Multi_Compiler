'use strict';

/**
 * Practice set (#1).
 *
 * Problems are written for this IDE's model: a complete program that reads from
 * stdin and writes to stdout. That is deliberately not LeetCode's "fill in a
 * Solution method" shape - the visible harness here is just main(), so nothing is
 * hidden from the user and every problem runs with the same toolchain and limits
 * as any other program.
 */

const PROBLEMS = [
  {
    id: 'two-sum',
    title: 'Two Sum',
    difficulty: 'easy',
    tags: ['array', 'hash map'],
    statement: `Given an array of n integers and a target, find two different positions
whose values add up to the target.

Input
  line 1: n target
  line 2: n integers

Output
  the two 0-based positions, smaller first, separated by a space.
  If several pairs work, print any. If none works, print -1.

A brute-force pair search is O(n^2); a hash map gets you O(n).`,
    samples: [
      { input: '4 9\n2 7 11 15\n', expected: '0 1\n' },
      { input: '3 6\n3 2 4\n', expected: '1 2\n' },
    ],
    hidden: [
      { input: '2 6\n3 3\n', expected: '0 1\n' },
      { input: '5 1\n-3 4 3 90 0\n', expected: '0 1\n' },
      { input: '3 100\n1 2 3\n', expected: '-1\n' },
      { input: '6 0\n-1 1 2 3 -2 4\n', expected: '0 1\n' },
    ],
    starters: {
      cpp: `#include <iostream>
#include <vector>
#include <unordered_map>

int main() {
    int n, target;
    if (!(std::cin >> n >> target)) return 0;
    std::vector<int> a(n);
    for (int &x : a) std::cin >> x;

    // TODO: find i < j with a[i] + a[j] == target
    std::cout << -1 << "\\n";
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        int target = sc.nextInt();
        int[] a = new int[n];
        for (int i = 0; i < n; i++) a[i] = sc.nextInt();

        // TODO: find i < j with a[i] + a[j] == target
        System.out.println(-1);
    }
}
`,
      python: `import sys

data = sys.stdin.read().split()
n, target = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))

# TODO: find i < j with a[i] + a[j] == target
print(-1)
`,
    },
  },
  {
    id: 'max-subarray',
    title: 'Maximum Subarray Sum',
    difficulty: 'easy',
    tags: ['array', 'dp', 'kadane'],
    statement: `Given an array of n integers (possibly all negative), find the largest sum
of a non-empty contiguous subarray.

Input
  line 1: n
  line 2: n integers

Output
  the maximum subarray sum.

Kadane's algorithm does it in one pass: keep a running sum, reset it when it goes
negative, and remember the best value seen.`,
    samples: [
      { input: '8\n-2 1 -3 4 -1 2 1 -5\n', expected: '6\n' },
      { input: '3\n-5 -2 -9\n', expected: '-2\n' },
    ],
    hidden: [
      { input: '1\n7\n', expected: '7\n' },
      { input: '5\n1 2 3 4 5\n', expected: '15\n' },
      { input: '4\n-1 -2 -3 -4\n', expected: '-1\n' },
      { input: '6\n2 -8 3 -2 4 -1\n', expected: '5\n' },
    ],
    starters: {
      cpp: `#include <iostream>
#include <vector>
#include <algorithm>

int main() {
    int n;
    if (!(std::cin >> n)) return 0;
    std::vector<long long> a(n);
    for (auto &x : a) std::cin >> x;

    // TODO: Kadane's algorithm
    std::cout << 0 << "\\n";
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long[] a = new long[n];
        for (int i = 0; i < n; i++) a[i] = sc.nextLong();

        // TODO: Kadane's algorithm
        System.out.println(0);
    }
}
`,
      python: `import sys

data = sys.stdin.read().split()
n = int(data[0])
a = list(map(int, data[1:1 + n]))

# TODO: Kadane's algorithm
print(0)
`,
    },
  },
  {
    id: 'valid-parentheses',
    title: 'Valid Parentheses',
    difficulty: 'easy',
    tags: ['stack', 'string'],
    statement: `Given a string made only of the characters ( ) [ ] { }, decide whether every
bracket is closed by the matching kind, in the right order.

Input
  line 1: the string s

Output
  YES if the string is balanced, otherwise NO.

An empty string counts as balanced. Push openers on a stack and pop on closers.`,
    samples: [
      { input: '()[]{}\n', expected: 'YES\n' },
      { input: '([)]\n', expected: 'NO\n' },
    ],
    hidden: [
      { input: '(]\n', expected: 'NO\n' },
      { input: '(((())))\n', expected: 'YES\n' },
      { input: '(\n', expected: 'NO\n' },
      { input: '\n', expected: 'YES\n' },
    ],
    starters: {
      cpp: `#include <iostream>
#include <string>
#include <stack>

int main() {
    std::string s;
    std::getline(std::cin, s);

    // TODO: decide whether s is balanced
    std::cout << "NO" << "\\n";
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.hasNextLine() ? sc.nextLine() : "";

        // TODO: decide whether s is balanced
        System.out.println("NO");
    }
}
`,
      python: `import sys

s = sys.stdin.readline().rstrip('\\n')

# TODO: decide whether s is balanced
print("NO")
`,
    },
  },
  {
    id: 'fibonacci',
    title: 'Nth Fibonacci',
    difficulty: 'easy',
    tags: ['dp', 'math'],
    statement: `Compute F(n) where F(0) = 0, F(1) = 1 and F(n) = F(n-1) + F(n-2).

Input
  line 1: n (0 <= n <= 1,000,000)

Output
  F(n) modulo 1,000,000,007.

Naive recursion is far too slow. Iterate and keep only the last two values.`,
    samples: [
      { input: '10\n', expected: '55\n' },
      { input: '0\n', expected: '0\n' },
    ],
    hidden: [
      { input: '1\n', expected: '1\n' },
      { input: '2\n', expected: '1\n' },
      { input: '50\n', expected: '586268941\n' },
      { input: '1000000\n', expected: '918091266\n' },
    ],
    starters: {
      cpp: `#include <iostream>

int main() {
    int n;
    if (!(std::cin >> n)) return 0;

    // TODO: iterate, keep the last two values, take everything mod 1e9+7
    std::cout << 0 << "\\n";
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();

        // TODO: iterate, keep the last two values, mod 1e9+7
        System.out.println(0);
    }
}
`,
      python: `import sys

n = int(sys.stdin.readline())

# TODO: iterate, keep the last two values, mod 1e9+7
print(0)
`,
    },
  },
  {
    id: 'binary-search',
    title: 'Binary Search',
    difficulty: 'easy',
    tags: ['binary search', 'array'],
    statement: `You are given a sorted array of n distinct integers and q queries. For each
query x, print the 0-based index of x, or -1 if it is not present.

Input
  line 1: n q
  line 2: n sorted integers
  line 3: q integers (the queries)

Output
  q lines, one answer per query.

A linear scan is O(nq) and will be too slow on the large tests.`,
    samples: [
      { input: '5 2\n1 3 5 7 9\n3 8\n', expected: '1\n-1\n' },
      { input: '1 1\n42\n42\n', expected: '0\n' },
    ],
    hidden: [
      { input: '3 3\n10 20 30\n10 30 25\n', expected: '0\n2\n-1\n' },
      { input: '6 2\n-5 -1 0 3 7 9\n-5 9\n', expected: '0\n5\n' },
      { input: '4 4\n2 4 6 8\n2 4 6 8\n', expected: '0\n1\n2\n3\n' },
    ],
    starters: {
      cpp: `#include <iostream>
#include <vector>

int main() {
    int n, q;
    if (!(std::cin >> n >> q)) return 0;
    std::vector<long long> a(n);
    for (auto &x : a) std::cin >> x;

    for (int i = 0; i < q; i++) {
        long long x;
        std::cin >> x;
        // TODO: binary search for x in a
        std::cout << -1 << "\\n";
    }
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        int q = sc.nextInt();
        long[] a = new long[n];
        for (int i = 0; i < n; i++) a[i] = sc.nextLong();

        for (int i = 0; i < q; i++) {
            long x = sc.nextLong();
            // TODO: binary search for x in a
            System.out.println(-1);
        }
    }
}
`,
      python: `import sys

data = sys.stdin.read().split()
n, q = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
queries = list(map(int, data[2 + n:2 + n + q]))

for x in queries:
    # TODO: binary search for x in a
    print(-1)
`,
    },
  },
  {
    id: 'longest-substring',
    title: 'Longest Substring Without Repeats',
    difficulty: 'medium',
    tags: ['sliding window', 'string', 'hash map'],
    statement: `Given a string s, find the length of the longest substring that contains no
repeated character.

Input
  line 1: the string s (lowercase letters and digits)

Output
  a single integer: the length of the longest such substring.

A sliding window with a "last seen position" map runs in O(n).`,
    samples: [
      { input: 'abcabcbb\n', expected: '3\n' },
      { input: 'bbbbb\n', expected: '1\n' },
    ],
    hidden: [
      { input: 'pwwkew\n', expected: '3\n' },
      { input: '\n', expected: '0\n' },
      { input: 'dvdf\n', expected: '3\n' },
      { input: 'abcdefghij\n', expected: '10\n' },
      { input: 'abba\n', expected: '2\n' },
    ],
    starters: {
      cpp: `#include <iostream>
#include <string>
#include <vector>

int main() {
    std::string s;
    std::getline(std::cin, s);

    // TODO: sliding window
    std::cout << 0 << "\\n";
    return 0;
}
`,
      java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.hasNextLine() ? sc.nextLine() : "";

        // TODO: sliding window
        System.out.println(0);
    }
}
`,
      python: `import sys

s = sys.stdin.readline().rstrip('\\n')

# TODO: sliding window
print(0)
`,
    },
  },
];

function list() {
  return PROBLEMS.map((p) => ({
    id: p.id,
    title: p.title,
    difficulty: p.difficulty,
    tags: p.tags,
    samples: p.samples.length,
    hidden: p.hidden.length,
  }));
}

function get(id) {
  return PROBLEMS.find((p) => p.id === id) || null;
}

module.exports = { list, get, PROBLEMS };
