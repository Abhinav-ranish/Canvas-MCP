import { z } from "zod";
import { CanvasClient } from "./canvas.js";

export interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (input: z.infer<S>, client: CanvasClient) => Promise<unknown>;
}

const idSchema = z.union([z.string(), z.number()]);

export const tools: ToolDef<z.ZodTypeAny>[] = [
  {
    name: "whoami",
    description:
      "Return the authenticated Canvas user (id, name, email). Useful for validating a PAT.",
    schema: z.object({}),
    handler: (_input, c) => c.whoami(),
  },
  {
    name: "list_courses",
    description:
      "List the authenticated student's courses. Defaults to active enrollments. Returns id, name, course_code, term, and dates.",
    schema: z.object({
      enrollment_state: z.enum(["active", "completed", "invited"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler: (input, c) =>
      c.listCourses({ enrollmentState: input.enrollment_state, limit: input.limit }),
  },
  {
    name: "get_course",
    description: "Get a single course by id, including syllabus body if available.",
    schema: z.object({ course_id: idSchema }),
    handler: (input, c) => c.getCourse(input.course_id),
  },
  {
    name: "list_modules",
    description:
      "List modules for a course, with their items inlined. Use to see the structure of a course's content.",
    schema: z.object({
      course_id: idSchema,
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (input, c) => c.listModules(input.course_id, input.limit),
  },
  {
    name: "list_module_items",
    description:
      "List items in a specific module (files, pages, assignments, quizzes, links).",
    schema: z.object({
      course_id: idSchema,
      module_id: idSchema,
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (input, c) => c.listModuleItems(input.course_id, input.module_id, input.limit),
  },
  {
    name: "get_file_metadata",
    description: "Get Canvas file metadata (display_name, content-type, size, download URL).",
    schema: z.object({ file_id: idSchema }),
    handler: (input, c) => c.getFile(input.file_id),
  },
  {
    name: "get_file_text",
    description:
      "Download a Canvas file and return up to max_bytes of its body decoded as UTF-8 text. Best for plaintext/markdown/code/HTML; binary formats (PDF, DOCX) return raw bytes — extract text upstream.",
    schema: z.object({
      file_id: idSchema,
      max_bytes: z.number().int().min(1024).max(2_000_000).optional(),
    }),
    handler: (input, c) => c.getFileText(input.file_id, input.max_bytes),
  },
  {
    name: "list_pages",
    description: "List wiki pages for a course.",
    schema: z.object({
      course_id: idSchema,
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler: (input, c) => c.listPages(input.course_id, input.limit),
  },
  {
    name: "get_page",
    description: "Get a wiki page's full body (HTML) by its url slug.",
    schema: z.object({ course_id: idSchema, page_url: z.string() }),
    handler: (input, c) => c.getPage(input.course_id, input.page_url),
  },
  {
    name: "list_assignments",
    description:
      "List assignments for a course ordered by due date. Returns due_at, points_possible, description, submission types.",
    schema: z.object({
      course_id: idSchema,
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (input, c) => c.listAssignments(input.course_id, input.limit),
  },
  {
    name: "get_assignment",
    description: "Get full details for a single assignment, including HTML description.",
    schema: z.object({ course_id: idSchema, assignment_id: idSchema }),
    handler: (input, c) => c.getAssignment(input.course_id, input.assignment_id),
  },
  {
    name: "list_my_submissions",
    description:
      "List the current student's submissions for a course, including grade, score, late/missing flags, and the linked assignment. Use to detect grade drops and missing work.",
    schema: z.object({
      course_id: idSchema,
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (input, c) => c.listMySubmissions(input.course_id, input.limit),
  },
  {
    name: "list_announcements",
    description: "List announcements across one or more courses.",
    schema: z.object({
      course_ids: z.array(idSchema).min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    handler: (input, c) => c.listAnnouncements(input.course_ids, input.limit),
  },
  {
    name: "list_upcoming",
    description:
      "List the current user's upcoming events (assignments + calendar items) across all courses. Use for deadline-aware planning.",
    schema: z.object({}),
    handler: (_input, c) => c.listUpcoming(),
  },
  {
    name: "get_syllabus",
    description: "Get the syllabus body (HTML) for a course.",
    schema: z.object({ course_id: idSchema }),
    handler: (input, c) => c.getSyllabus(input.course_id),
  },
];
