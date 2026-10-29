# React + Vite

VEH-P1 bổ sung Student Vehicle Rental (Hub/global, reserve/pickup/return/cancel, own recovery/polling) vào shell và HTTP/session hiện có. Hướng dẫn demo populated bằng DEMO_NAME và lệnh test duy nhất ở README root; Vehicle browser suite dùng CDP/file SQLite thật. Không TTL tự động hoặc Charging/Operator.

SmartEMobilityHub: xem [hướng dẫn local tại repo root](../../README.md) để cài dependencies, tạo env, cấu hình API base/port, chạy backend/frontend và tests. P4 Auth/session/hash guards được giữ; P5 đã thay Parking/Overview bằng dashboard GET SQLite thật. Commands và test/demo-data limits ở README root. Phần template/compiler notes bên dưới là lịch sử công cụ, không phải thiết kế UI hiện hành.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
