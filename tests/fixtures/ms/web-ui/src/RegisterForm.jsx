import React, { useState, useEffect } from 'react';
import axios from 'axios';

export function RegisterForm() {
  const [status, setStatus] = useState('');

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

  return <button onClick={() => submit('user:pw')}>Register {status}</button>;
}
