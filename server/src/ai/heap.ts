// Binary min-heap priority queue. Pure, dependency-free — used by the A*
// pathfinder to extract the lowest-f-score node each iteration.
//
// Items are stored with a priority; pop() returns the lowest-priority entry.
// Ties break implicitly by insertion order of last-updated sift (stable
// enough for A*, where ties between equal-f nodes just pick one arbitrarily).

interface HeapEntry<T> {
  item: T;
  priority: number;
}

export class BinaryHeap<T> {
  private readonly data: HeapEntry<T>[] = [];

  get size(): number { return this.data.length; }

  push(item: T, priority: number): void {
    this.data.push({ item, priority });
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapEntry<T> | null {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): HeapEntry<T> | null {
    return this.data[0] ?? null;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].priority >= this.data[parent].priority) return;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      const left  = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left  < n && this.data[left].priority  < this.data[smallest].priority) smallest = left;
      if (right < n && this.data[right].priority < this.data[smallest].priority) smallest = right;
      if (smallest === i) return;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}
