🗺️ FloorCraft: Interactive Floor Plan Builder - Project Roadmap & Architecture
This repository contains a full-stack, containerized 2D interactive diagramming platform. It allows users to design, generate, and edit interactive building layouts (desks, walls, AC units, lighting nodes) on a grid-snapped canvas.

🛠️ Technology Stack
Frontend: React (TypeScript), react-konva (Canvas Engine), TanStack Query (Server State Management).

Backend: Python, Django REST Framework (DRF), PostgreSQL (Database).

Infrastructure: Docker, Docker Compose, Nginx (Reverse Proxy).

🏗️ 1. Orchestration & Proxy Architecture (Docker)
To make development match production, the entire stack runs inside isolated Docker containers. Nginx acts as the single point of entry (reverse proxy), routing /api/ traffic to Django, database metrics to your management tools, and all other traffic to the React frontend.

⚡ 4. Critical Technical Gotchas to Watch Out For
Canvas Coordinate Scoping: Never mix regular HTML components inside a Konva <Layer>. It will throw a fatal runtime engine error. Standard buttons or asset sidebars must sit outside the <Stage> component.

State Debounce Control: Do not trigger TanStack queries or database writes on onDragMove (which executes constantly during drag actions). Only fire your database sync actions on onDragEnd (when the user drops the item).

CORS & Proxying: Because we use Nginx to process every request under the exact same port (80), you will completely avoid cross-origin resource sharing (CORS) security blockers between your React build and your Django controllers.

Directory Matrix

floorcraft/
│
├── docker-compose.yml # Configured with ./volumes/ bind mounts
├── .gitignore # Ignoring /volumes/
├── README.md
│
├── volumes/ # ⚡ PERSISTENT DOCKER STORAGE (Ignored by Git)
│ ├── pgdata/ # Live PostgreSQL binary database files
│ └── media/ # Django uploaded user assets (e.g., custom SVG/PNG furniture icons)
│
├── nginx/
│ └── nginx.conf
│
├── backend/ # Django REST Framework Backend
│ ├── Dockerfile
│ ├── requirements.txt
│ ├── manage.py
│ ├── core/
│ └── fm_generator/
│
└── frontend_ts/ # Vite + React + TypeScript Frontend
├── Dockerfile
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
