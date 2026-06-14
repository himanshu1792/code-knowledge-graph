import React from 'react';
import { Routes, Route } from 'react-router-dom';
import App from './App.jsx';
import { RegisterForm } from './RegisterForm.jsx';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/home" element={<App />} />
      <Route path="/register" element={<RegisterForm title="Register" />} />
    </Routes>
  );
}
