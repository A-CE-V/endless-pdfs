const queues = {
  conversion: [],
  editor: [],
  ai: []
};

const activeUsers = new Map();
let isProcessing = false;

const priorities = {
  deluxe: 4,
  premium: 3,
  standard: 2,
  free: 1,
};

export function priorityMiddleware(category = "conversion") {
  return (req, res, next) => {
    const plan = (req.user?.selectedPlan || "free").toLowerCase();
    const priority = priorities[plan] || 1;

    const queue = queues[category];
    if (!queue) return res.status(500).json({ error: "Invalid queue category" });

    const request = { req, res, next, priority, category };
    queue.push(request);

    queue.sort((a, b) => b.priority - a.priority);

    processQueue(category);
  };
}

async function processQueue(category) {
  if (isProcessing) return;
  isProcessing = true;

  const queue = queues[category];
  while (queue.length > 0) {
    const { req, res, next } = queue[0];
    const plan = (req.user?.selectedPlan || "free").toLowerCase();
    const userId = req.user?.id;

    const maxConcurrent =
      plan === "deluxe" && category === "conversion" ? 2 : 1;
    const activeKey = `${userId}_${category}`;
    const activeCount = activeUsers.get(activeKey) || 0;

    if (activeCount >= maxConcurrent) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    queue.shift();
    activeUsers.set(activeKey, activeCount + 1);

    (async () => {
      try {
        next();
      } catch (err) {
        console.error("Queue error:", err);
        res.status(500).json({ error: "Queue processing failed" });
      } finally {
        activeUsers.set(activeKey, (activeUsers.get(activeKey) || 1) - 1);
        if (activeUsers.get(activeKey) <= 0) {
          activeUsers.delete(activeKey);
        }
        processQueue(category);
      }
    })();
  }

  isProcessing = false;
}
