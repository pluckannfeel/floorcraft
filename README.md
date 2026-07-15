# FloorCraft

FloorCraft is a full-stack, containerized 2D interactive floor plan builder and workplace layout editor. Users register and log in, then design building layouts on a grid-snapped canvas: placing catalog furniture and fixtures, drawing freeform shapes and lines, and editing item properties — all backed by a real API with optimistic updates and undo/redo.

## Technology Stack

**Frontend:** React (TypeScript), Vite, react-konva / Konva.js (2D canvas engine), TanStack Query (server state), Zustand + zundo (client state and undo/redo), React Router.

**Backend:** Python, Django REST Framework, PostgreSQL.

**Infrastructure:** Docker, Docker Compose, Nginx (reverse proxy and TLS termination).

## Architecture

The stack runs entirely inside Docker containers, both in development and in any deployed environment, so local dev matches production topology. Nginx is the single entry point: it terminates TLS, routes `/api/` and `/admin/` to Django, `/static/` to Django's static files, and everything else to the React frontend. Because both frontend and backend are served through the same origin, the app never needs CORS configuration, and cookies work the same way in every environment.

```
┌────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Nginx  │─────▶│ Django + DRF     │─────▶│ PostgreSQL        │
│ (TLS)  │      │ (accounts,       │      │                    │
│        │      │  fm_generator)   │      └──────────────────┘
│        │
│        │─────▶│ Vite + React      │
└────────┘      │ (auth, canvas)    │
                 └──────────────────┘
```

## Features

**Authentication** — Email-based registration (full name, email, contact number, country, job title), required email verification before login, password reset, and session-based auth with CSRF protection. No third-party auth provider; the whole flow is self-hosted.

**Floor plan editor** — A Konva-based canvas, gated behind login, for a single shared floor plan:

- **Catalog objects**: drag furniture/fixture types (tables, chairs, doors, appliances, lighting, and more) from a sidebar onto the canvas.
- **Freeform shapes**: draw rectangles, squares, and circles directly on the canvas, click-drag to size.
- **Freeform lines**: draw straight, curved, or S-curve lines by clicking points, with draggable anchor points for reshaping after placement.
- **Selection & manipulation**: select, drag, resize, and rotate any placed item, with grid-snapping and canvas-bounds clamping.
- **Undo/redo**: every create, move, resize, rotate, delete, and reorder action is undoable within the session.
- **Zoom & pan**: mouse wheel, pinch, and toolbar controls, with zoom-to-cursor behavior.
- **Alignment guides**: Figma-style edge/center snapping between items while dragging or resizing.
- **Layering**: bring-to-front / send-to-back controls for overlapping items.
- **Property panel**: view and edit an item's name and type-specific properties.
- **PNG export**: export the current floor plan as an image.
- **Persistence**: every change syncs to the backend with optimistic UI updates — the canvas responds instantly, and any failed request reverts cleanly with an on-screen notification.

## Getting Started

Requires Docker and Docker Compose.

1. Copy the environment template and fill in real values:
   ```bash
   cp .env.example .env
   ```
2. Bring up the stack:
   ```bash
   docker compose up -d
   ```
3. Run database migrations:
   ```bash
   docker compose exec backend python manage.py migrate
   ```
4. Create an admin account:
   ```bash
   docker compose exec backend python manage.py createsuperuser
   ```
5. Visit the app at `https://localhost/` (or whatever host/port your `.env` and `docker-compose.yml` are configured for). Register a new account, verify the email (printed to the backend container's logs by the local console email backend), and log in.

## Project Structure

```
floorcraft/
├── docker-compose.yml
├── nginx/                  # Reverse proxy config, local TLS certs
├── backend/                 # Django project
│   ├── core/                 # Settings, URL routing
│   ├── accounts/              # Custom user model, registration, auth
│   └── fm_generator/           # Floor plan / object data model and API
└── frontend_ts/              # Vite + React + TypeScript app
    └── src/
        ├── api/                 # Axios client
        ├── auth/                 # Auth pages and context
        ├── canvas/                # Canvas editor components
        ├── state/                  # Zustand store (undo/redo)
        ├── hooks/                   # React Query hooks
        └── notifications/            # Toast notifications
```

## Roadmap

Planned improvements, in no particular order:

- Styling overhaul with Tailwind CSS and a component library (shadcn/ui + Base UI).
- Broader page navigation beyond the single canvas route.
- Support for creating and switching between multiple floor plans per user.
- Image/vector-based rendering for catalog objects instead of plain colored boxes.
- A general UI/UX pass on the editor's layout and controls — including a more conventional file-menu structure (File → New / Save).
- Ruler guides along the canvas edges (horizontal and vertical) for precise placement.
