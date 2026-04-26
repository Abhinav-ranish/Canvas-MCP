/**
 * Thin Canvas LMS REST client.
 *
 * Auth: Personal Access Token (Bearer).
 * Base URL example: https://canvas.asu.edu/api/v1
 */

export interface CanvasConfig {
  baseUrl: string;
  token: string;
}

export class CanvasError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: CanvasConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw text
      }
      throw new CanvasError(
        `Canvas API ${res.status} ${res.statusText} for ${path}`,
        res.status,
        body,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Paginated GET. Follows the Canvas Link header until exhausted or `max` reached.
   */
  private async getAll<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    max = 200,
  ): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = (() => {
      const u = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
      for (const [k, v] of Object.entries({ per_page: 100, ...query })) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
      return u.toString();
    })();

    while (url && results.length < max) {
      const res: Response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CanvasError(
          `Canvas API ${res.status} ${res.statusText} for ${url}`,
          res.status,
          text,
        );
      }
      const page = (await res.json()) as T[];
      results.push(...page);
      url = parseNextLink(res.headers.get("link"));
    }
    return results.slice(0, max);
  }

  // ---------- Auth probe ----------

  whoami() {
    return this.request<{ id: number; name: string; email?: string }>(`/users/self`);
  }

  // ---------- Courses ----------

  listCourses(opts: { enrollmentState?: "active" | "completed" | "invited"; limit?: number } = {}) {
    return this.getAll<CanvasCourse>(
      "/courses",
      {
        enrollment_state: opts.enrollmentState ?? "active",
        "include[]": "term",
      },
      opts.limit ?? 100,
    );
  }

  getCourse(courseId: number | string) {
    return this.request<CanvasCourse>(`/courses/${courseId}`, {
      query: { "include[]": "syllabus_body" },
    });
  }

  // ---------- Modules ----------

  listModules(courseId: number | string, limit = 200) {
    return this.getAll<CanvasModule>(
      `/courses/${courseId}/modules`,
      { "include[]": "items" },
      limit,
    );
  }

  listModuleItems(courseId: number | string, moduleId: number | string, limit = 200) {
    return this.getAll<CanvasModuleItem>(
      `/courses/${courseId}/modules/${moduleId}/items`,
      {},
      limit,
    );
  }

  // ---------- Files / Pages ----------

  getFile(fileId: number | string) {
    return this.request<CanvasFile>(`/files/${fileId}`);
  }

  /** Downloads file body as text. Caller decides encoding. Truncated to maxBytes. */
  async getFileText(fileId: number | string, maxBytes = 200_000): Promise<string> {
    const meta = await this.getFile(fileId);
    if (!meta.url) throw new CanvasError("File has no download URL", 404, meta);
    const res = await fetch(meta.url);
    if (!res.ok) throw new CanvasError(`File download failed: ${res.status}`, res.status);
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return new TextDecoder("utf-8", { fatal: false }).decode(slice);
  }

  listPages(courseId: number | string, limit = 100) {
    return this.getAll<CanvasPage>(`/courses/${courseId}/pages`, {}, limit);
  }

  getPage(courseId: number | string, pageUrl: string) {
    return this.request<CanvasPage>(`/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
  }

  // ---------- Assignments / Grades ----------

  listAssignments(courseId: number | string, limit = 200) {
    return this.getAll<CanvasAssignment>(
      `/courses/${courseId}/assignments`,
      { order_by: "due_at" },
      limit,
    );
  }

  getAssignment(courseId: number | string, assignmentId: number | string) {
    return this.request<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`);
  }

  /** Current user's submissions for a course (includes grade + score). */
  listMySubmissions(courseId: number | string, limit = 200) {
    return this.getAll<CanvasSubmission>(
      `/courses/${courseId}/students/submissions`,
      { student_ids: "self", "include[]": "assignment" },
      limit,
    );
  }

  // ---------- Announcements / Calendar ----------

  listAnnouncements(courseIds: (number | string)[], limit = 50) {
    return this.getAll<CanvasDiscussionTopic>(
      `/announcements`,
      Object.fromEntries(courseIds.map((id, i) => [`context_codes[${i}]`, `course_${id}`])),
      limit,
    );
  }

  /** Upcoming events (assignments + calendar) for the current user. */
  listUpcoming() {
    return this.request<CanvasCalendarEvent[]>(`/users/self/upcoming_events`);
  }

  getSyllabus(courseId: number | string) {
    return this.request<CanvasCourse>(`/courses/${courseId}`, {
      query: { "include[]": "syllabus_body" },
    });
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Canvas returns: <url>; rel="next", <url>; rel="last", ...
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// ---------- Canvas types (minimal subset) ----------

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  workflow_state?: string;
  start_at?: string | null;
  end_at?: string | null;
  syllabus_body?: string | null;
  term?: { name?: string };
}

export interface CanvasModule {
  id: number;
  name: string;
  position?: number;
  unlock_at?: string | null;
  state?: string;
  items_count?: number;
  items?: CanvasModuleItem[];
}

export interface CanvasModuleItem {
  id: number;
  module_id: number;
  title: string;
  type:
    | "File"
    | "Page"
    | "Discussion"
    | "Assignment"
    | "Quiz"
    | "SubHeader"
    | "ExternalUrl"
    | "ExternalTool";
  content_id?: number;
  page_url?: string;
  external_url?: string;
  html_url?: string;
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename?: string;
  "content-type"?: string;
  size?: number;
  url?: string;
  updated_at?: string;
}

export interface CanvasPage {
  url: string;
  title: string;
  body?: string;
  updated_at?: string;
  published?: boolean;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number;
  submission_types?: string[];
  html_url?: string;
}

export interface CanvasSubmission {
  id: number;
  assignment_id: number;
  score: number | null;
  grade: string | null;
  submitted_at?: string | null;
  graded_at?: string | null;
  late?: boolean;
  missing?: boolean;
  assignment?: CanvasAssignment;
}

export interface CanvasDiscussionTopic {
  id: number;
  title: string;
  message?: string;
  posted_at?: string | null;
  html_url?: string;
  context_code?: string;
}

export interface CanvasCalendarEvent {
  id: number;
  title: string;
  type?: string;
  start_at?: string | null;
  end_at?: string | null;
  html_url?: string;
  context_code?: string;
}
