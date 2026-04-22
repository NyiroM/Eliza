# Eliza
Eliza - AI Job Assistant

ELIZA : Empathetic Link for Intelligent Job Acquire

ELIZA is a specialized AI-driven workflow tool designed to increase job application success rates through data-driven personalization and ATS optimization. The project focuses on a deterministic pipeline that calculates job fit and generates tailored application bundles while keeping the user in full control of the process.

ELIZA is a high-precision, AI-driven workflow assistant designed to eliminate the "spray-and-pray" approach to job hunting. Unlike mass-automation bots, ELIZA prioritizes application quality and human oversight through a deterministic, transparent pipeline.

## 📊 Project Status This project is actively managed using GitHub Projects. You can track our progress, milestones, and upcoming features on our [Public Roadmap/Kanban Board](https://github.com/users/NyiroM/projects/1)

🎯 Core Mission

The system bridges the gap between candidates and Applicant Tracking Systems (ATS) by generating highly personalized, data-driven application materials. It is built to solve the industry-wide problem of low conversion rates caused by generic, non-optimized submissions.

💡 Key Value Propositions

Fit-First Analysis: Instead of applying blindly, users receive an instant "Fit Score" (0–100%) and a gap analysis to decide if a role is worth their effort.

Copilot UX Philosophy: ELIZA functions as an assistant, not a replacement. All AI-generated content remains fully visible and editable by the user.

Non-Negotiable Narratives: The system ensures that the candidate's unique "Core Stories" are consistently integrated into every tailored resume and cover letter.

ATS Mastery: Automated keyword integration and bullet point rewriting ensure that documents are optimized for both human recruiters and automated filters.

🛠 Technical Architecture

Frontend: Next.js Web Application and a React-based Chrome Extension for real-time interaction.

Backend: Node.js/Python API deployed in a serverless environment (Vercel/AWS).

Intelligence: A dual-model strategy using cost-efficient LLMs (Ollama/Llama 3/Mistral) for parsing and high-reasoning models (GPT-4o/Sonnet) for final generation.

Storage: PostgreSQL with pgvector for semantic matching and experience tracking.

🚀 MVP Feature Set

Dual-Parser Engine: Structured data extraction from both complex PDF resumes and varied job descriptions.

Weighted Matching: A semantic scoring engine that evaluates skill overlap and seniority alignment.

Application Bundle: One-click generation of a tailored Resume and a personalized Cover Letter.

Browser Integration: Real-time scoring overlay on platforms like LinkedIn to provide immediate decision support.

📂 Project Structure

├── apps/
│   ├── web/                # Next.js Dashboard & Landing Page
│   └── extension/          # Chrome Extension (React + Tailwind)
├── packages/
│   ├── core/               # Shared logic: Parsing, Scoring, LLM Utils
│   ├── database/           # Prisma/Drizzle schema & pgvector logic
│   └── ui/                 # Shared UI components (shadcn/ui)
└── docs/                   # Detailed technical documentation


🏗 Setup & Installation (Local Development)

Prerequisites

Node.js (v20+)

Docker (for PostgreSQL & Open WebUI)

Ollama (for local LLM execution)

Steps

Clone the repository

git clone [https://github.com/username/eliza.git](https://github.com/username/eliza.git)
cd eliza


Install dependencies

npm install


Configure Environment Variables
Create a .env file in the root directory and add your configurations (refer to .env.example).

Start local LLM

ollama run llama3


Run development server

npm run dev


⚖️ License

This project is licensed under the MIT License - see the LICENSE file for details.

"Don't apply blind. Apply smart."