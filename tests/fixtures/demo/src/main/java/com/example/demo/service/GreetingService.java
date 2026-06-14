package com.example.demo.service;

import com.example.demo.dao.GreetingDao;
import com.example.demo.util.StringUtils;
import org.springframework.stereotype.Service;

@Service
public class GreetingService {

    private final GreetingDao dao;

    public GreetingService(GreetingDao dao) {
        this.dao = dao;
    }

    public String greet(String name) {
        String base = dao.template();
        return StringUtils.shout(StringUtils.reverse(base + name));
    }
}
