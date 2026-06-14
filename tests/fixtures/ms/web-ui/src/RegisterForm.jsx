import React, { useState, useEffect, useContext } from 'react';
import axios from 'axios';
import { AuthContext } from './AuthContext.jsx';

export function RegisterForm({ title }) {
  const [status, setStatus] = useState('');
  const auth = useContext(AuthContext);

  useEffect(() => {
    axios.get('/auth/validate');
  }, []);

  async function submit(credentials) {
    const res = await fetch('/users/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    setStatus(await res.text());
  }

  return <button onClick={() => submit('user:pw')}>{title} {status}</button>;
}
